"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const prisma_service_1 = require("../database/prisma.service");
const password_1 = require("./utils/password");
const session_token_1 = require("./utils/session-token");
function toSafeUser(user) {
    return { id: user.id, email: user.email, name: user.name, status: user.status };
}
let AuthService = class AuthService {
    constructor(prisma, configService) {
        this.prisma = prisma;
        this.configService = configService;
        this.sessionTtlSeconds = this.configService.get('auth.sessionTtlSeconds', { infer: true }) ?? 28800;
    }
    normalizeEmail(email) {
        return email.trim().toLowerCase();
    }
    async loadActiveMemberships(userId) {
        const memberships = await this.prisma.membership.findMany({
            where: { userId, tenant: { status: 'ACTIVE' } },
            include: { tenant: true },
        });
        return memberships.map((m) => ({
            tenantId: m.tenantId,
            tenantName: m.tenant.name,
            role: m.role,
        }));
    }
    async login(rawEmail, password) {
        const email = this.normalizeEmail(rawEmail);
        const user = await this.prisma.user.findUnique({ where: { email } });
        const hashToCompare = user?.passwordHash ?? password_1.DUMMY_HASH;
        const passwordMatches = await (0, password_1.verifyPassword)(password, hashToCompare);
        if (!user || !user.passwordHash || !passwordMatches || user.status !== 'ACTIVE') {
            throw new common_1.UnauthorizedException('Invalid email or password');
        }
        const rawToken = (0, session_token_1.generateSessionToken)();
        const tokenHash = (0, session_token_1.hashSessionToken)(rawToken);
        const expiresAt = new Date(Date.now() + this.sessionTtlSeconds * 1000);
        await this.prisma.$transaction([
            this.prisma.session.create({ data: { userId: user.id, tokenHash, expiresAt } }),
            this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
        ]);
        const memberships = await this.loadActiveMemberships(user.id);
        return { rawToken, identity: { user: toSafeUser(user), memberships } };
    }
    async validateSession(rawToken) {
        const tokenHash = (0, session_token_1.hashSessionToken)(rawToken);
        const session = await this.prisma.session.findUnique({
            where: { tokenHash },
            include: { user: true },
        });
        if (!session || session.revokedAt || session.expiresAt <= new Date()) {
            return null;
        }
        if (session.user.status !== 'ACTIVE') {
            return null;
        }
        void this.prisma.session
            .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
            .catch(() => undefined);
        const memberships = await this.loadActiveMemberships(session.user.id);
        return { user: toSafeUser(session.user), memberships };
    }
    async logout(rawToken) {
        if (!rawToken)
            return;
        const tokenHash = (0, session_token_1.hashSessionToken)(rawToken);
        await this.prisma.session.updateMany({
            where: { tokenHash, revokedAt: null },
            data: { revokedAt: new Date() },
        });
    }
    async register(email, password, name) {
        const normalizedEmail = this.normalizeEmail(email);
        const passwordHash = await (0, password_1.hashPassword)(password);
        const user = await this.prisma.user.create({
            data: { email: normalizedEmail, name, passwordHash, status: 'ACTIVE' },
        });
        return toSafeUser(user);
    }
};
exports.AuthService = AuthService;
exports.AuthService = AuthService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        config_1.ConfigService])
], AuthService);
//# sourceMappingURL=auth.service.js.map