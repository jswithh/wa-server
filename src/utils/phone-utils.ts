/**
 * Utility functions for phone number handling
 */

/**
 * Clean phone number by removing WhatsApp suffixes and device identifiers
 * Examples:
 * - "6285156808928:54@s.whatsapp.net" -> "6285156808928"
 * - "6281316088377@s.whatsapp.net" -> "6281316088377"
 * - "6285156808928:54" -> "6285156808928"
 */
export function cleanPhoneNumber(phoneNumber: string | undefined | null): string {
    if (!phoneNumber) return "";

    const cleanedNumber = String(phoneNumber)
        .replace("@s.whatsapp.net", "")  // Remove WhatsApp suffix
        .split(":")[0];                  // Remove device identifier like :54

    return cleanedNumber || "";
}

/**
 * Format phone number to WhatsApp JID format
 */
export function toWhatsAppJID(phoneNumber: string): string {
    return `${cleanPhoneNumber(phoneNumber)}@s.whatsapp.net`;
}

/**
 * Extract phone number from WhatsApp JID
 */
export function fromWhatsAppJID(jid: string): string {
    return cleanPhoneNumber(jid);
}
