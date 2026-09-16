export interface SafeUser {
    id: string;
    email: string;
    name: string | null;
    status: 'ACTIVE' | 'SUSPENDED';
}
export interface MembershipSummary {
    tenantId: string;
    tenantName: string;
    role: string;
}
export interface AuthenticatedUser {
    user: SafeUser;
    memberships: MembershipSummary[];
}
