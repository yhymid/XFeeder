// src/parsers/utils.js

/**
 * Konwertuje różne formaty dat (RSS, Atom, ISO, Unix Timestamp) na spójny format ISO 8601.
 * @param {string|Date|number} dateInput Surowy ciąg daty, obiekt Date lub timestamp.
 * @returns {string|null} Data w formacie ISO 8601 lub null, jeśli parsowanie się nie powiodło.
 */
function parseDate(dateInput) {
    if (!dateInput) {
        return null;
    }
    
    let date;

    // 1. Obsługa timestampów (liczba)
    if (typeof dateInput === 'number') {
        // Unix timestamp: sekundy (10 cyfr) lub milisekundy (13+ cyfr)
        if (dateInput.toString().length === 10) {
            // Konwertuj sekundy na milisekundy
            date = new Date(dateInput * 1000); 
        } else {
            // Zakładamy milisekundy
            date = new Date(dateInput); 
        }
    } 
    // 2. Obsługa ciągów (RSS, Atom, ISO)
    else if (typeof dateInput === 'string') {
        // Konstruktor Date w Node.js jest bardzo dobry w parsowaniu większości standardów (RFC 822, ISO 8601)
        date = new Date(dateInput);
    } 
    // 3. Obsługa już sparsowanych obiektów Date
    else if (dateInput instanceof Date) {
        date = dateInput;
    } 
    else {
        return null; 
    }

    // Weryfikacja, czy data jest prawidłowa (getTime zwróci NaN dla nieprawidłowych dat)
    if (isNaN(date.getTime())) {
        return null;
    }

    // Zwróć datę w jednolitym formacie ISO 8601
    return date.toISOString();
}

module.exports = { 
    parseDate 
};