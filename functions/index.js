const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");
const xml2js = require("xml2js");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");

admin.initializeApp();
const db = admin.firestore();

exports.getExchangeRateForDate = onCall(
    { 
        region: "europe-west1", 
        timeoutSeconds: 30,
        memory: "128MiB",
        // cors: true // v2 onCall için bu seçenek doğrudan desteklenmeyebilir, manuel handler gerekebilir
                    // veya HTTP fonksiyonuna çevirip cors middleware'ini kullanabiliriz.
                    // Şimdilik onCall'da bırakalım ve client-side'da cors hatası devam ederse
                    // HTTP fonksiyona çevirmeyi düşünelim.
                    // Aslında, onCall fonksiyonları için Firebase otomatik CORS handle eder.
                    // Sorunumuz büyük ihtimalle client-side'daki fonksiyon çağırma şekliyle ilgili olabilir
                    // veya preflight request'te bir sorun oluyor.
                    // Preflight requestler için callable functions'ta özel bir ayar gerekmez.
                    // Hata mesajı "No 'Access-Control-Allow-Origin' header" diyor.
                    // Bu, fonksiyonun kendisi bir HTTP fonksiyonu olsaydı daha anlamlı olurdu.
                    // Callable functions için Firebase bu headerları kendisi yönetmeli.
    }, 
    async (request) => {
    
    // Kimlik doğrulama kontrolü (kaldırıldı, gerekirse eklenebilir)
    // if (!request.auth) {
    //   logger.error("Authentication Error: User is not authenticated.");
    //   throw new HttpsError('unauthenticated', 'Bu fonksiyonu çağırmak için kimlik doğrulaması gereklidir.');
    // }

    const dateString = request.data.date; 
    if (!dateString || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
        logger.error("Geçersiz tarih formatı:", { receivedDate: dateString });
        throw new HttpsError('invalid-argument', 'Lütfen YYYY-AA-GG formatında geçerli bir tarih girin.');
    }

    const parts = dateString.split('-');
    const year = parts[0];
    const month = parts[1];
    const day = parts[2];
    const tcmbDatePath = `${year}${month}/${day}${month}${year}.xml`;
    const tcmbURL = `https://www.tcmb.gov.tr/kurlar/${tcmbDatePath}`;
    const ratesDocRef = db.collection("dailyExchangeRates").doc(dateString);

    logger.info(`İstenen tarih için kur çekiliyor: ${dateString}, URL: ${tcmbURL}`);

    try {
        const ratesDoc = await ratesDocRef.get();
        if (ratesDoc.exists) {
            const docData = ratesDoc.data();
            if (docData.rates && Object.keys(docData.rates).length > 0) {
                logger.info(`Firestore'dan kur bilgisi bulundu (${dateString}):`, docData.rates);
                return { success: true, rates: docData.rates, source: "Firestore" };
            }
            if (docData.error && docData.lastFetched) {
                const lastFetchedDate = docData.lastFetched.toDate();
                const hoursSinceLastFetch = (new Date() - lastFetchedDate) / (1000 * 60 * 60);
                if (hoursSinceLastFetch < 6 && (docData.error === "TCMB_404" || docData.error === "No valid rates found or parse error")) {
                    logger.warn(`Daha önce ${dateString} için hata alınmış (${docData.error}), ${hoursSinceLastFetch.toFixed(1)} saat içinde tekrar denenmeyecek.`);
                    throw new HttpsError('not-found', `TCMB'den ${dateString} için daha önce veri bulunamadı (${docData.error}). Tekrar denemek için bir süre bekleyin.`);
                }
            }
        }

        logger.info(`TCMB'den kur çekiliyor: ${tcmbURL}`);
        const response = await axios.get(tcmbURL, { timeout: 15000 });
        const parser = new xml2js.Parser({ explicitArray: false, trim: true });
        const result = await parser.parseStringPromise(response.data);
        const fetchedRates = {};
        if (result && result.Tarih_Date && result.Tarih_Date.Currency) {
            const currencies = Array.isArray(result.Tarih_Date.Currency) ? result.Tarih_Date.Currency : [result.Tarih_Date.Currency];
            currencies.forEach(currency => {
                if (currency && currency.$ && currency.$.Kod) {
                    const currencyCode = currency.$.Kod;
                    if (currencyCode === "USD" || currencyCode === "EUR") {
                        const forexSelling = currency.ForexSelling;
                        if (forexSelling && typeof forexSelling === 'string' && forexSelling.trim() !== "") {
                            const rateValue = parseFloat(forexSelling.replace(",", "."));
                            if (!isNaN(rateValue)) { fetchedRates[currencyCode] = rateValue; }
                        }
                    }
                }
            });
        }

        if (Object.keys(fetchedRates).length > 0 && (fetchedRates.USD || fetchedRates.EUR)) {
            await ratesDocRef.set({ rates: fetchedRates, lastFetched: admin.firestore.FieldValue.serverTimestamp(), error: null }, { merge: true });
            logger.info(`Yeni kur bilgisi Firestore'a kaydedildi (${dateString}):`, fetchedRates);
            return { success: true, rates: fetchedRates, source: "TCMB" };
        } else {
            logger.warn(`TCMB'den ${dateString} için geçerli kur bilgisi (USD/EUR) bulunamadı veya parse edilemedi. Dönen XML:`, JSON.stringify(result, null, 2).substring(0, 500));
            await ratesDocRef.set({ rates: {}, lastFetched: admin.firestore.FieldValue.serverTimestamp(), error: "No valid rates found or parse error" }, { merge: true });
            throw new HttpsError('not-found', `TCMB'den ${dateString} için geçerli kur bilgisi (USD/EUR) bulunamadı.`);
        }
    } catch (error) {
        logger.error(`Kur çekme/kaydetme hatası (${dateString}):`, { message: error.message, code: error.code, details: error.details, responseStatus: error.response?.status });
        let userErrorCode = 'internal'; let userErrorMessage = `Kur bilgisi alınırken bir sunucu hatası oluştu (${dateString}).`;
        if (error instanceof HttpsError) { throw error; }
        if (error.isAxiosError) {
            if (error.response) {
                if (error.response.status === 404) {
                    userErrorCode = 'not-found'; userErrorMessage = `TCMB'den ${dateString} için kur verisi bulunamadı (muhtemelen tatil veya hafta sonu).`;
                    await ratesDocRef.set({ rates: {}, lastFetched: admin.firestore.FieldValue.serverTimestamp(), error: "TCMB_404" }, { merge: true }).catch(dbError => logger.error("Error saving 404 status to Firestore:", dbError));
                }
            } else if (error.request) { userErrorCode = 'unavailable'; userErrorMessage = `TCMB sunucusundan yanıt alınamadı (${dateString}).`; }
        }
        throw new HttpsError(userErrorCode, userErrorMessage);
    }
});