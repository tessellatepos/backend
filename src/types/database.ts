export interface IConfigSystem {
    id: number;
    createdAt: Date;
    encryptedAccessToken: string;
    encryptedRefreshToken: string;
    updatedAt: Date;
}
