import { readSecret } from '../secrets.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function failure(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}

export function toBase64Url(bytes) {
  return btoa(Array.from(new Uint8Array(bytes), byte => String.fromCharCode(byte)).join(''))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(encoded) {
  return Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}

export function nonce(size = 32) {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(size)));
}

export async function challenge(verifier) {
  return toBase64Url(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)));
}

export class VaultCipher {
  #material;
  #key;
  #vaultId;

  constructor(material, vaultId) {
    this.#material = material;
    this.#vaultId = vaultId;
  }

  #getKey() {
    if (!this.#key) {
      // The vault master key is a fixed-version secret, unlike an API credential.
      // Updating it needs a ciphertext migration; do not follow rotating values
      // within a live vault. A transient initial lookup failure remains retryable.
      this.#key = (async () => {
        const material = await readSecret(this.#material, { code: 'vault_key_invalid', maxBytes: 128 });
        try {
          const raw = decode(material);
          if (raw.length !== 32) throw Error();
          return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
        } catch { throw failure('vault_key_invalid', 503); }
      })().catch(error => { this.#key = undefined; throw error; });
    }
    return this.#key;
  }

  #params(binding, iv) {
    return { name: 'AES-GCM', iv, additionalData: encoder.encode(JSON.stringify([this.#vaultId, ...binding])) };
  }

  async seal(binding, value) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const body = await crypto.subtle.encrypt(this.#params(binding, iv), await this.#getKey(), encoder.encode(JSON.stringify(value)));
    return toBase64Url(iv) + '.' + toBase64Url(body);
  }

  async open(binding, sealed) {
    const key = await this.#getKey();
    try {
      const [iv, body] = sealed.split('.');
      const data = await crypto.subtle.decrypt(this.#params(binding, decode(iv)), key, decode(body));
      return JSON.parse(decoder.decode(data));
    } catch { throw failure('vault_decryption_failed', 503); }
  }
}
