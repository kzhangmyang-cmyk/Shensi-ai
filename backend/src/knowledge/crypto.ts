import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export interface KnowledgeAad { workspaceId: string; actorId: string; kind: string; id: string; versionId?: string; }
export function createKnowledgeCrypto(secret: string) {
  if (typeof secret !== 'string' || secret.trim().length < 32) throw new Error('knowledge_key_required');
  const derive = (purpose: string) => Buffer.from(hkdfSync('sha256', secret, 'shensi.knowledge.v1', purpose, 32));
  const metadataKey = derive('metadata'), originalKey = derive('original'), cursorKey = derive('cursor');
  const aadBytes = (aad: KnowledgeAad) => {
    if (!aad.workspaceId || !aad.actorId || !aad.kind || !aad.id) throw new Error('knowledge_aad_invalid');
    return Buffer.from(JSON.stringify(['shensi.knowledge.v1', aad.workspaceId, aad.actorId, aad.kind, aad.id, aad.versionId ?? null]));
  };
  return Object.freeze({
    seal(aad: KnowledgeAad, value: unknown): string {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', metadataKey, iv);
      cipher.setAAD(aadBytes(aad));
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return ['k1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
    },
    open<T>(aad: KnowledgeAad, sealed: string): T {
      try {
        const [version, iv, tag, payload, ...extra] = sealed.split('.');
        if (version !== 'k1' || extra.length || !iv || !tag || !payload) throw new Error();
        const nonce = Buffer.from(iv, 'base64url'), authTag = Buffer.from(tag, 'base64url');
        if (nonce.length !== 12 || authTag.length !== 16) throw new Error();
        const decipher = createDecipheriv('aes-256-gcm', metadataKey, nonce);
        decipher.setAAD(aadBytes(aad)); decipher.setAuthTag(authTag);
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload, 'base64url')), decipher.final()]).toString('utf8')) as T;
      } catch { throw new Error('knowledge_authentication_invalid'); }
    },
    fileCipher(aad: KnowledgeAad, iv: Buffer) {
      const cipher = createCipheriv('aes-256-gcm', originalKey, iv); cipher.setAAD(aadBytes(aad)); return cipher;
    },
    fileDecipher(aad: KnowledgeAad, iv: Buffer, tag: Buffer) {
      const decipher = createDecipheriv('aes-256-gcm', originalKey, iv);
      decipher.setAAD(aadBytes(aad)); decipher.setAuthTag(tag); return decipher;
    },
    signCursor(body: string) { return createHmac('sha256', cursorKey).update(body).digest('base64url'); },
    verifyCursor(body: string, signature: string) {
      const expected = createHmac('sha256', cursorKey).update(body).digest(), received = Buffer.from(signature, 'base64url');
      return expected.length === received.length && timingSafeEqual(expected, received);
    }
  });
}
export type KnowledgeCrypto = ReturnType<typeof createKnowledgeCrypto>;
