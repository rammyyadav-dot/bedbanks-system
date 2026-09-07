export interface JwtPayload {
  sub: string; // userId
  tenantId: string;
  email: string;
  roles: string[];
  iat?: number;
  exp?: number;
}
