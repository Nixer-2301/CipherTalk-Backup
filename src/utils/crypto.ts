export async function hashPassword(password: string, salt?: string): Promise<{ hash: string, salt: string }> {
    const enc = new TextEncoder();
    const saltStr = salt || window.crypto.randomUUID();
    const saltBuffer = enc.encode(saltStr);
    const passwordBuffer = enc.encode(password);

    const keyMaterial = await window.crypto.subtle.importKey(
        "raw",
        passwordBuffer,
        "PBKDF2",
        false,
        ["deriveBits", "deriveKey"]
    );

    const derivedBits = await window.crypto.subtle.deriveBits(
        {
            name: "PBKDF2",
            salt: saltBuffer,
            iterations: 100000,
            hash: "SHA-256"
        },
        keyMaterial,
        256
    );

    const hashArray = Array.from(new Uint8Array(derivedBits));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    return { hash: hashHex, salt: saltStr };
}
