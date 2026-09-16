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
exports.SessionAuthGuard = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const auth_service_1 = require("../auth.service");
const auth_constants_1 = require("../auth.constants");
let SessionAuthGuard = class SessionAuthGuard {
    constructor(authService, configService) {
        this.authService = authService;
        this.configService = configService;
    }
    async canActivate(context) {
        const request = context.switchToHttp().getRequest();
        const cookieName = this.configService.get('auth.cookieName', { infer: true }) ?? 'fbeds_session';
        const rawToken = request.cookies?.[cookieName];
        if (!rawToken) {
            throw new common_1.UnauthorizedException('Not authenticated');
        }
        const identity = await this.authService.validateSession(rawToken);
        if (!identity) {
            throw new common_1.UnauthorizedException('Session is invalid or has expired');
        }
        request[auth_constants_1.REQUEST_USER_KEY] = identity;
        return true;
    }
};
exports.SessionAuthGuard = SessionAuthGuard;
exports.SessionAuthGuard = SessionAuthGuard = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [auth_service_1.AuthService,
        config_1.ConfigService])
], SessionAuthGuard);
//# sourceMappingURL=session-auth.guard.js.map