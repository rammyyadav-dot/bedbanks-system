import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
declare class SearchHotelsDto {
    destination: string;
    checkIn: string;
    checkOut: string;
    rooms: number;
    adults: number;
    children: number;
    nationality: string;
    currency?: string;
}
export declare class AgentController {
    context(identity: AuthenticatedUser): {
        user: import("../auth/interfaces/authenticated-user.interface").SafeUser;
        memberships: import("../auth/interfaces/authenticated-user.interface").MembershipSummary[];
        capabilities: string[];
    };
    search(criteria: SearchHotelsDto, identity: AuthenticatedUser): {
        request: {
            currency: string;
            destination: string;
            checkIn: string;
            checkOut: string;
            rooms: number;
            adults: number;
            children: number;
            nationality: string;
        };
        tenantIds: string[];
        status: "provider_unavailable";
        hotels: never[];
        total: number;
        message: string;
    };
    finance(identity: AuthenticatedUser): {
        tenantIds: string[];
        status: "not_configured";
        currency: string;
        availableCredit: null;
        message: string;
    };
}
export {};
