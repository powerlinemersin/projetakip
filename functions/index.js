const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions"); // Opsiyonel, loglama için

// ... (admin, axios, xml2js importları ve admin.initializeApp() aynı kalacak) ...

exports.getExchangeRateForDate = onCall(
    { 
        region: "europe-west1", // Bölgeyi obje içinde belirtin
        // memory: "256MiB", // Opsiyonel: Bellek ayarı
        // timeoutSeconds: 60, // Opsiyonel: Zaman aşımı ayarı
    }, 
    async (request) => { // context yerine request objesi gelir, içinde auth ve data var
    
    // Opsiyonel: Kimlik doğrulama kontrolü
    // if (!request.auth) {
    //   logger.error("Authentication Error: User is not authenticated.");
    //   throw new HttpsError('unauthenticated', 'Bu fonksiyonu çağırmak için kimlik doğrulaması gereklidir.');
    // }

    const dateString = request.data.date; // data, request.data içinden alınır
    if (!dateString || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
        logger.error("Invalid argument: Date format is incorrect.", { receivedDate: dateString });
        throw new HttpsError('invalid-argument', 'Lütfen YYYY-AA-GG formatında geçerli bir tarih girin.');
    }

    // ... (fonksiyonun geri kalan mantığı büyük ölçüde aynı kalacak) ...
    // Sadece HttpsError fırlatırken `functions.https.HttpsError` yerine `HttpsError` kullanın.
    // Ve console.log yerine logger.info, logger.error vb. kullanabilirsiniz.

    // Örnek hata fırlatma:
    // throw new HttpsError('not-found', `TCMB'den ${dateString} için kur bilgisi bulunamadı.`);

    // Fonksiyonun geri kalanını bir önceki mesajdaki gibi, HttpsError ve logger düzeltmeleriyle yazın.
    // Özellikle catch bloklarındaki throw new functions.https.HttpsError(...) kısımlarını
    // throw new HttpsError(...) olarak değiştirin.
    
    // --- Fonksiyonun geri kalanını buraya ekleyin (bir önceki mesajdaki gibi, HttpsError ve logger'ı güncelleyerek) ---
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
                if (hoursSinceLastFetch < 6 && (docData.error === "TCMB_404" || docData.error === "No rates found or parse error")) {
                    logger.warn(`Daha önce ${dateString} için hata alınmış (${docData.error}), ${hoursSinceLastFetch.toFixed(1)} saat içinde tekrar denenmeyecek.`);
                    throw new HttpsError('not-found', `TCMB'den ${dateString} için daha önce veri bulunamadı (${docData.error}).`);
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
                            fetchedRates[currencyCode] = parseFloat(forexSelling.replace(",", "."));
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
            logger.warn(`TCMB'den ${dateString} için geçerli kur bilgisi bulunamadı veya parse edilemedi. Dönen XML:`, JSON.stringify(result, null, 2));
            await ratesDocRef.set({ rates: {}, lastFetched: admin.firestore.FieldValue.serverTimestamp(), error: "No valid rates found or parse error" }, { merge: true });
            throw new HttpsError('not-found', `TCMB'den ${dateString} için geçerli kur bilgisi (USD/EUR) bulunamadı.`);
        }
    } catch (error) {
        logger.error(`Kur çekme/kaydetme hatası (${dateString}):`, error.message, error);
        let errorCode = 'internal';
        let errorMessage = `Kur bilgisi alınırken bir sunucu hatası oluştu (${dateString}).`;

        if (error.isAxiosError) {
            if (error.response) {
                logger.error("TCMB Yanıt Verisi:", error.response.data); logger.error("TCMB Yanıt Durumu:", error.response.status);
                if (error.response.status === 404) {
                    errorCode = 'not-found'; errorMessage = `TCMB'den ${dateString} için kur verisi bulunamadı (muhtemelen tatil veya hafta sonu).`;
                    await ratesDocRef.set({ rates: {}, lastFetched: admin.firestore.FieldValue.serverTimestamp(), error: "TCMB_404" }, { merge: true }).catch(dbError => logger.error("Error saving 404 status to Firestore:", dbError));
                }
            } else if (error.request) { errorCode = 'unavailable'; errorMessage = `TCMB sunucusundan yanıt alınamadı (${dateString}).`; }
        } else if (error.code && typeof error.code === 'string') { errorCode = error.code; errorMessage = error.message; }
        
        if (!(error instanceof HttpsError)) { throw new HttpsError(errorCode, errorMessage); } 
        else { throw error; }
    }
});