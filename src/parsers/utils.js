// src/parsers/utils.js - Shared utility functions for parsers

/**
 * Converts various date formats (RSS, Atom, ISO, Unix Timestamp) to consistent ISO 8601 format.
 * 
 * @param {string|Date|number} dateInput - Raw date string, Date object, or timestamp
 * @returns {string|null} Date in ISO 8601 format or null if parsing failed
 */
function parseDate(dateInput) {
  if (!dateInput) {
    return null;
  }

  let date;

  // 1. Handle timestamps (numbers)
  if (typeof dateInput === "number") {
    // Unix timestamp: seconds (10 digits) or milliseconds (13+ digits)
    if (dateInput.toString().length === 10) {
      // Convert seconds to milliseconds
      date = new Date(dateInput * 1000);
    } else {
      // Assume milliseconds
      date = new Date(dateInput);
    }
  }
  // 2. Handle strings (RSS, Atom, ISO)
  else if (typeof dateInput === "string") {
    // Node.js Date constructor handles most standards (RFC 822, ISO 8601)
    date = new Date(dateInput);
  }
  // 3. Handle already parsed Date objects
  else if (dateInput instanceof Date) {
    date = dateInput;
  }
  else {
    return null;
  }

  // Validate date (getTime returns NaN for invalid dates)
  if (isNaN(date.getTime())) {
    return null;
  }

  // Return date in unified ISO 8601 format
  return date.toISOString();
}

module.exports = {
  parseDate
};