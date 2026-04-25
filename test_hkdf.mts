import { nip44, generateSecretKey, getPublicKey } from "nostr-tools";

// Test HKDF expand: our Kotlin-style vs nostr-tools
function kotlinHkdfExpand(prk, info, length) {
    // Simulate javax.crypto.Mac
    function hmacSha256(key, data) {
        const { createHmac } = await import("node:crypto");
        return createHmac("sha256", Buffer.from(key)).update(Buffer.from(data)).digest();
    }
}
