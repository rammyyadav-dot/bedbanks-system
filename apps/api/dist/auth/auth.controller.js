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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthController = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const swagger_1 = require("@nestjs/swagger");
const auth_service_1 = require("./auth.service");
const current_user_decorator_1 = require("./decorators/current-user.decorator");
const login_dto_1 = require("./dto/login.dto");
const session_auth_guard_1 = require("./guards/session-auth.guard");
let AuthController = class AuthController {
    constructor(authService, configService) {
        this.authService = authService;
        this.configService = configService;
    }
    cookieOptions() {
        const name = this.configService.get('auth.cookieName', { infer: true }) ?? 'fbeds_session';
        const sameSite = this.configService.get('auth.cookieSameSite', { infer: true }) ?? 'lax';
        const secure = this.configService.get('auth.cookieSecure', { infer: true }) ?? false;
        const ttlSeconds = this.configService.get('auth.sessionTtlSeconds', { infer: true }) ?? 28800;
        return { name, httpOnly: true, sameSite, secure, path: '/', maxAge: ttlSeconds * 1000 };
    }
    async login(dto, res) {
        const { rawToken, identity } = await this.authService.login(dto.email, dto.password);
        const { name, ...options } = this.cookieOptions();
        res.cookie(name, rawToken, options);
        return identity;
    }
    me(identity) {
        return identity;
    }
    async logout(req, res) {
        const { name, path } = this.cookieOptions();
        const rawToken = req.cookies?.[name];
        await this.authService.logout(rawToken);
        res.clearCookie(name, { path });
        return { loggedOut: true };
    }
};
exports.AuthController = AuthController;
__decorate([
    (0, common_1.Post)('login'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, swagger_1.ApiOperation)({ summary: 'Authenticate and receive a session cookie' }),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Res)({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [login_dto_1.LoginDto, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "login", null);
__decorate([
    (0, common_1.Get)('me'),
    (0, common_1.UseGuards)(session_auth_guard_1.SessionAuthGuard),
    (0, swagger_1.ApiOperation)({ summary: 'Return the identity associated with the current session' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], AuthController.prototype, "me", null);
__decorate([
    (0, common_1.Post)('logout'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, swagger_1.ApiOperation)({ summary: 'Revoke the current session and clear the cookie' }),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Res)({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "logout", null);
exports.AuthController = AuthController = __decorate([
    (0, swagger_1.ApiTags)('auth'),
    (0, common_1.Controller)('auth'),
    __metadata("design:paramtypes", [auth_service_1.AuthService,
        config_1.ConfigService])
], AuthController);
//# sourceMappingURL=auth.controller.js.map