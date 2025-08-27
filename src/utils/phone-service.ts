/**
 * Centralized Phone Number Service with Caching and Optimization
 * Consolidates all phone number operations to eliminate redundancy
 */

import { LRUCache } from "lru-cache";
import { logger } from "./logger";

interface PhoneNumberResult {
  cleaned: string;
  whatsappJid: string;
  normalized: string;
  isValid: boolean;
  countryCode: string;
}

interface CacheStats {
  size: number;
  maxSize: number;
  hitRate: number;
  totalRequests: number;
  cacheHits: number;
}

/**
 * Optimized phone number service with intelligent caching
 * Replaces scattered phone utility functions throughout the codebase
 */
export class PhoneNumberService {
  private cache: LRUCache<string, PhoneNumberResult>;
  private stats = {
    totalRequests: 0,
    cacheHits: 0,
    cleanOperations: 0,
    normalizeOperations: 0,
    validationOperations: 0,
  };

  // Common patterns for phone number cleaning
  private static readonly PATTERNS = {
    WHATSAPP_SUFFIX: /@s\.whatsapp\.net$/,
    DEVICE_IDENTIFIER: /:(\d+)$/,
    NON_DIGITS: /\D/g,
    INDONESIAN_PREFIX: /^0/,
    COUNTRY_CODE_62: /^62/,
    VALID_PHONE: /^(\+?62|62|0)[0-9]{8,13}$/,
  };

  constructor(cacheSize: number = 10000, cacheTTL: number = 3600000) {
    // 1 hour TTL
    this.cache = new LRUCache<string, PhoneNumberResult>({
      max: cacheSize,
      ttl: cacheTTL,
      allowStale: false,
      updateAgeOnGet: true,
      updateAgeOnHas: true,
    });

    logger.debug("PhoneNumberService initialized", {
      cacheSize,
      cacheTTL: `${cacheTTL}ms`,
    });
  }

  /**
   * Main processing method - handles all phone number operations
   * Replaces: cleanPhoneNumber, normalizePhoneNumber, validatePhoneNumber, toWhatsAppJID
   */
  processPhoneNumber(
    phoneNumber: string | undefined | null,
  ): PhoneNumberResult {
    this.stats.totalRequests++;

    if (!phoneNumber) {
      return this.createEmptyResult();
    }

    const cacheKey = String(phoneNumber);

    // Check cache first
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.stats.cacheHits++;
      return cached;
    }

    // Process phone number
    const result = this.processPhoneNumberInternal(cacheKey);

    // Cache the result
    this.cache.set(cacheKey, result);

    return result;
  }

  /**
   * Internal processing logic
   */
  private processPhoneNumberInternal(phoneNumber: string): PhoneNumberResult {
    // Step 1: Clean the phone number
    const cleaned = this.cleanPhoneNumberInternal(phoneNumber);
    this.stats.cleanOperations++;

    if (!cleaned) {
      return this.createEmptyResult();
    }

    // Step 2: Normalize the phone number
    const normalized = this.normalizePhoneNumberInternal(cleaned);
    this.stats.normalizeOperations++;

    // Step 3: Validate the phone number
    const isValid = this.validatePhoneNumberInternal(normalized);
    this.stats.validationOperations++;

    // Step 4: Generate WhatsApp JID
    const whatsappJid = `${cleaned}@s.whatsapp.net`;

    // Step 5: Extract country code
    const countryCode = this.extractCountryCode(normalized);

    return {
      cleaned,
      whatsappJid,
      normalized,
      isValid,
      countryCode,
    };
  }

  /**
   * Optimized phone number cleaning
   * Replaces multiple scattered cleanPhoneNumber functions
   */
  private cleanPhoneNumberInternal(phoneNumber: string): string {
    return String(phoneNumber)
      .replace(PhoneNumberService.PATTERNS.WHATSAPP_SUFFIX, "")
      .replace(PhoneNumberService.PATTERNS.DEVICE_IDENTIFIER, "")
      .trim();
  }

  /**
   * Optimized phone number normalization
   * Assumes Indonesian numbers if no country code is present
   */
  private normalizePhoneNumberInternal(phoneNumber: string): string {
    // Remove all non-digit characters
    const digitsOnly = phoneNumber.replace(
      PhoneNumberService.PATTERNS.NON_DIGITS,
      "",
    );

    // Handle Indonesian numbers
    if (PhoneNumberService.PATTERNS.INDONESIAN_PREFIX.test(digitsOnly)) {
      return "62" + digitsOnly.substring(1);
    }

    // Add Indonesian country code if missing
    if (!PhoneNumberService.PATTERNS.COUNTRY_CODE_62.test(digitsOnly)) {
      return "62" + digitsOnly;
    }

    return digitsOnly;
  }

  /**
   * Optimized phone number validation
   */
  private validatePhoneNumberInternal(phoneNumber: string): boolean {
    return PhoneNumberService.PATTERNS.VALID_PHONE.test(phoneNumber);
  }

  /**
   * Extract country code from normalized number
   */
  private extractCountryCode(phoneNumber: string): string {
    if (phoneNumber.startsWith("62")) return "62";
    if (phoneNumber.startsWith("1")) return "1";
    if (phoneNumber.startsWith("44")) return "44";
    // Add more country codes as needed
    return "unknown";
  }

  /**
   * Create empty result for invalid inputs
   */
  private createEmptyResult(): PhoneNumberResult {
    return {
      cleaned: "",
      whatsappJid: "",
      normalized: "",
      isValid: false,
      countryCode: "unknown",
    };
  }

  // === PUBLIC API METHODS ===

  /**
   * Clean phone number (replaces cleanPhoneNumber function)
   */
  clean(phoneNumber: string | undefined | null): string {
    return this.processPhoneNumber(phoneNumber).cleaned;
  }

  /**
   * Normalize phone number (replaces normalizePhoneNumber function)
   */
  normalize(phoneNumber: string | undefined | null): string {
    return this.processPhoneNumber(phoneNumber).normalized;
  }

  /**
   * Validate phone number (replaces validatePhoneNumber function)
   */
  validate(phoneNumber: string | undefined | null): boolean {
    return this.processPhoneNumber(phoneNumber).isValid;
  }

  /**
   * Convert to WhatsApp JID (replaces toWhatsAppJID function)
   */
  toWhatsAppJID(phoneNumber: string | undefined | null): string {
    return this.processPhoneNumber(phoneNumber).whatsappJid;
  }

  /**
   * Extract from WhatsApp JID (replaces fromWhatsAppJID function)
   */
  fromWhatsAppJID(jid: string | undefined | null): string {
    if (!jid) return "";
    return this.clean(jid);
  }

  /**
   * Get country code for a phone number
   */
  getCountryCode(phoneNumber: string | undefined | null): string {
    return this.processPhoneNumber(phoneNumber).countryCode;
  }

  /**
   * Batch process multiple phone numbers efficiently
   */
  processBatch(
    phoneNumbers: (string | undefined | null)[],
  ): PhoneNumberResult[] {
    return phoneNumbers.map((phone) => this.processPhoneNumber(phone));
  }

  /**
   * Check if two phone numbers are equivalent
   */
  areEquivalent(
    phone1: string | undefined | null,
    phone2: string | undefined | null,
  ): boolean {
    const normalized1 = this.normalize(phone1);
    const normalized2 = this.normalize(phone2);
    return normalized1 === normalized2 && normalized1 !== "";
  }

  // === CACHE MANAGEMENT ===

  /**
   * Get cache statistics
   */
  getCacheStats(): CacheStats {
    return {
      size: this.cache.size,
      maxSize: this.cache.max,
      hitRate:
        this.stats.totalRequests > 0
          ? this.stats.cacheHits / this.stats.totalRequests
          : 0,
      totalRequests: this.stats.totalRequests,
      cacheHits: this.stats.cacheHits,
    };
  }

  /**
   * Get detailed service statistics
   */
  getServiceStats() {
    const cacheStats = this.getCacheStats();
    return {
      cache: cacheStats,
      operations: {
        totalRequests: this.stats.totalRequests,
        cacheHits: this.stats.cacheHits,
        cacheMisses: this.stats.totalRequests - this.stats.cacheHits,
        cleanOperations: this.stats.cleanOperations,
        normalizeOperations: this.stats.normalizeOperations,
        validationOperations: this.stats.validationOperations,
      },
      performance: {
        hitRate: `${(cacheStats.hitRate * 100).toFixed(2)}%`,
        averageOperationsPerRequest:
          this.stats.totalRequests > 0
            ? (this.stats.cleanOperations +
                this.stats.normalizeOperations +
                this.stats.validationOperations) /
              this.stats.totalRequests
            : 0,
      },
    };
  }

  /**
   * Clear cache (useful for testing or memory management)
   */
  clearCache(): void {
    this.cache.clear();
    logger.debug("PhoneNumberService cache cleared");
  }

  /**
   * Preload common phone numbers into cache
   */
  preloadCache(phoneNumbers: string[]): void {
    logger.debug(`Preloading ${phoneNumbers.length} phone numbers into cache`);
    phoneNumbers.forEach((phone) => {
      this.processPhoneNumber(phone);
    });
    logger.debug(`Cache preloading completed. Cache size: ${this.cache.size}`);
  }

  /**
   * Optimize cache by removing least recently used entries
   */
  optimizeCache(): void {
    const initialSize = this.cache.size;
    // LRU cache will automatically remove old entries when needed
    // This method can be extended for custom optimization logic
    logger.debug(
      `Cache optimization completed. Size: ${initialSize} -> ${this.cache.size}`,
    );
  }
}

// Export singleton instance
export const phoneNumberService = new PhoneNumberService();

// Export for testing or custom configurations
// (PhoneNumberService already exported above)

// Backward compatibility exports (to be deprecated)
export const cleanPhoneNumber = (phone: string | undefined | null): string =>
  phoneNumberService.clean(phone);

export const normalizePhoneNumber = (
  phone: string | undefined | null,
): string => phoneNumberService.normalize(phone);

export const validatePhoneNumber = (
  phone: string | undefined | null,
): boolean => phoneNumberService.validate(phone);

export const toWhatsAppJID = (phone: string | undefined | null): string =>
  phoneNumberService.toWhatsAppJID(phone);

export const fromWhatsAppJID = (jid: string | undefined | null): string =>
  phoneNumberService.fromWhatsAppJID(jid);
