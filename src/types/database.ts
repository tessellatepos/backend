export interface IConfigSystem {
    id: number;
    createdAt: Date;
    encryptedAccessToken: string;
    encryptedRefreshToken: string;
    applicationId: string | null;
    locationId: string | null;
    merchantId: string | null;
    tokenExpiresAt: Date | null;
    refreshTokenExpiresAt: Date | null;
    updatedAt: Date;
}
