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
exports.validate = validate;
const class_transformer_1 = require("class-transformer");
const class_validator_1 = require("class-validator");
var Environment;
(function (Environment) {
    Environment["Development"] = "development";
    Environment["Test"] = "test";
    Environment["Staging"] = "staging";
    Environment["Production"] = "production";
})(Environment || (Environment = {}));
class EnvironmentVariables {
    constructor() {
        this.NODE_ENV = Environment.Development;
        this.API_PORT = 3001;
        this.API_HOST = '0.0.0.0';
        this.API_PREFIX = 'api/v1';
        this.AUTH_SESSION_TTL_SECONDS = 28800;
        this.AUTH_COOKIE_NAME = 'fbeds_session';
        this.AUTH_COOKIE_SECURE = 'false';
        this.AUTH_COOKIE_SAME_SITE = 'lax';
        this.ADMIN_ORIGIN = 'http://localhost:3000';
    }
}
__decorate([
    (0, class_validator_1.IsEnum)(Environment),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", String)
], EnvironmentVariables.prototype, "NODE_ENV", void 0);
__decorate([
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(65535),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Number)
], EnvironmentVariables.prototype, "API_PORT", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", String)
], EnvironmentVariables.prototype, "API_HOST", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", String)
], EnvironmentVariables.prototype, "API_PREFIX", void 0);
__decorate([
    (0, class_validator_1.IsUrl)({ protocols: ['postgresql', 'postgres'], require_tld: false }, { message: 'DATABASE_URL must be a valid postgresql:// connection string' }),
    __metadata("design:type", String)
], EnvironmentVariables.prototype, "DATABASE_URL", void 0);
__decorate([
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(60, { message: 'AUTH_SESSION_TTL_SECONDS should be at least 60 seconds' }),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Number)
], EnvironmentVariables.prototype, "AUTH_SESSION_TTL_SECONDS", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", String)
], EnvironmentVariables.prototype, "AUTH_COOKIE_NAME", void 0);
__decorate([
    (0, class_validator_1.IsIn)(['true', 'false'], { message: 'AUTH_COOKIE_SECURE must be exactly "true" or "false"' }),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", String)
], EnvironmentVariables.prototype, "AUTH_COOKIE_SECURE", void 0);
__decorate([
    (0, class_validator_1.IsIn)(['lax', 'strict', 'none']),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", String)
], EnvironmentVariables.prototype, "AUTH_COOKIE_SAME_SITE", void 0);
__decorate([
    (0, class_validator_1.IsUrl)({ require_tld: false }, { message: 'ADMIN_ORIGIN must be a valid URL, e.g. http://localhost:3000' }),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", String)
], EnvironmentVariables.prototype, "ADMIN_ORIGIN", void 0);
function validate(config) {
    const validatedConfig = (0, class_transformer_1.plainToInstance)(EnvironmentVariables, config, {
        enableImplicitConversion: true,
    });
    const errors = (0, class_validator_1.validateSync)(validatedConfig, {
        skipMissingProperties: false,
    });
    if (errors.length > 0) {
        const message = errors
            .map((error) => Object.values(error.constraints ?? {}).join(', '))
            .join('; ');
        throw new Error(`Environment validation failed: ${message}`);
    }
    if (validatedConfig.NODE_ENV === Environment.Production && validatedConfig.AUTH_COOKIE_SECURE !== 'true') {
        throw new Error('Refusing to start: NODE_ENV=production requires AUTH_COOKIE_SECURE=true. ' +
            'Running with an insecure session cookie in production is not permitted.');
    }
    return validatedConfig;
}
//# sourceMappingURL=env.validation.js.map