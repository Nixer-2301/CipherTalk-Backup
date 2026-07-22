export function toBase64Url(buffer: Uint8Array): string {
    let binary = '';
    const len = buffer.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(buffer[i]);
    }
    return window.btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

export function fromBase64Url(base64url: string): Uint8Array {
    const base64 = base64url
        .replace(/-/g, '+')
        .replace(/_/g, '/');

    const padLen = (4 - (base64.length % 4)) % 4;
    const paddedBase64 = base64 + '='.repeat(padLen);

    const binary = window.atob(paddedBase64);
    const len = binary.length;
    const buffer = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        buffer[i] = binary.charCodeAt(i);
    }
    return buffer;
}
