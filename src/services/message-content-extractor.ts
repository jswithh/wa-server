import { whatsappLogger } from "../utils/logger";
import { messageProcessor } from "./message-processor";

// Map untuk menyimpan konten pesan yang ditemukan
const messageContentMap = new Map<string, string>();

/**
 * Service untuk menangkap konten pesan asli dari berbagai sumber
 */
export class MessageContentExtractor {

    /**
     * Interceptor untuk menangkap konten dari raw protocol data
     */
    static interceptProtocolData(data: any): void {
        try {
            const dataStr = JSON.stringify(data);

            // Cari pattern konten pesan dalam data mentah
            if (dataStr.includes('"conversation"')) {
                const conversationMatch = dataStr.match(/"conversation"\s*:\s*"([^"\\]*(\\.[^"\\]*)*)"/);
                if (conversationMatch && conversationMatch[1]) {
                    const content = conversationMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');

                    // Cari message ID yang terkait
                    let messageId = null;
                    if (data.key?.id) {
                        messageId = data.key.id;
                    } else {
                        const idMatch = dataStr.match(/"id"\s*:\s*"([^"]+)"/);
                        if (idMatch && idMatch[1]) {
                            messageId = idMatch[1];
                        }
                    }

                    if (messageId && content) {
                        messageContentMap.set(messageId, content);
                        whatsappLogger.info("🎯 Captured actual message content:", {
                            messageId: messageId,
                            content: content.substring(0, 100),
                            source: "conversation"
                        });
                    }
                }
            }

            // Cari pattern untuk extended text message
            if (dataStr.includes('"extendedTextMessage"')) {
                const textMatch = dataStr.match(/"text"\s*:\s*"([^"\\]*(\\.[^"\\]*)*)"/);
                if (textMatch && textMatch[1]) {
                    const content = textMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');

                    let messageId = null;
                    if (data.key?.id) {
                        messageId = data.key.id;
                    } else {
                        const idMatch = dataStr.match(/"id"\s*:\s*"([^"]+)"/);
                        if (idMatch && idMatch[1]) {
                            messageId = idMatch[1];
                        }
                    }

                    if (messageId && content) {
                        messageContentMap.set(messageId, content);
                        whatsappLogger.info("🎯 Captured extended text content:", {
                            messageId: messageId,
                            content: content.substring(0, 100),
                            source: "extendedTextMessage"
                        });
                    }
                }
            }

            // Cari pattern untuk receipt/ack messages dengan konten
            if (data.recv && data.recv.attrs) {
                const attrs = data.recv.attrs;
                if (attrs.id && attrs.from && !attrs.from.includes("status@broadcast")) {

                    // Cek apakah ada konten dalam data yang sama
                    if (dataStr.includes('"conversation"') || dataStr.includes('"text"')) {
                        const conversationMatch = dataStr.match(/"conversation"\s*:\s*"([^"\\]*(\\.[^"\\]*)*)"/);
                        const textMatch = dataStr.match(/"text"\s*:\s*"([^"\\]*(\\.[^"\\]*)*)"/);

                        const content = conversationMatch?.[1] || textMatch?.[1];
                        if (content) {
                            const cleanContent = content.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
                            messageContentMap.set(attrs.id, cleanContent);

                            whatsappLogger.info("🎯 Captured content from receipt data:", {
                                messageId: attrs.id,
                                content: cleanContent.substring(0, 100),
                                from: attrs.from,
                                source: "receipt_with_content"
                            });
                        }
                    }
                }
            }

        } catch (error) {
            // Ignore parsing errors, just log for debugging
            whatsappLogger.debug("Error parsing protocol data for content extraction:", error);
        }
    }

    /**
     * Mendapatkan konten pesan berdasarkan message ID
     */
    static getMessageContent(messageId: string): string | null {
        return messageContentMap.get(messageId) || null;
    }

    /**
     * Membersihkan konten pesan lama (untuk menghemat memory)
     */
    static cleanupOldContent(): void {
        const cutoffTime = Date.now() - (24 * 60 * 60 * 1000); // 24 jam
        const entriesToDelete: string[] = [];

        for (const [messageId, content] of messageContentMap.entries()) {
            // Dalam implementasi nyata, Anda bisa menyimpan timestamp juga
            // Untuk sekarang, kita batasi jumlah entries
            if (messageContentMap.size > 1000) {
                entriesToDelete.push(messageId);
            }
        }

        entriesToDelete.slice(0, 100).forEach(id => {
            messageContentMap.delete(id);
        });
    }

    /**
     * Interceptor untuk semua data yang masuk ke Baileys
     */
    static interceptAllData(data: any): void {
        // Jalankan cleanup secara berkala
        if (Math.random() < 0.01) { // 1% chance
            this.cleanupOldContent();
        }

        this.interceptProtocolData(data);
    }
}

export const messageContentExtractor = MessageContentExtractor;
