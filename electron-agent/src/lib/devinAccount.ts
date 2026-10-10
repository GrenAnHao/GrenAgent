/** Devin login state returned to the renderer. The token is never included. */
export interface DevinAccountView {
  state: 'missing' | 'expired' | 'revoked' | 'ok';
  expiresAt?: string;
  expirySource?: 'jwt' | 'fallback';
}
