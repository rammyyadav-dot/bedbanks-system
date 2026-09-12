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
exports.HealthController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const config_1 = require("@nestjs/config");
const prisma_service_1 = require("../database/prisma.service");
const SERVICE_NAME = 'fbeds-api';
const SERVICE_VERSION = '0.1.0';
let HealthController = class HealthController {
    constructor(configService, prisma) {
        this.configService = configService;
        this.prisma = prisma;
    }
    async check() {
        const databaseHealthy = await this.prisma.isHealthy();
        return {
            status: 'ok',
            service: SERVICE_NAME,
            version: SERVICE_VERSION,
            environment: this.configService.get('nodeEnv', { infer: true }) ?? 'development',
            timestamp: new Date().toISOString(),
            database: {
                status: databaseHealthy ? 'ok' : 'unavailable',
            },
        };
    }
};
exports.HealthController = HealthController;
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'Liveness and basic readiness check for the FBEDS API' }),
    (0, swagger_1.ApiResponse)({
        status: 200,
        description: 'The API process is running. Check database.status for DB connectivity.',
    }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], HealthController.prototype, "check", null);
exports.HealthController = HealthController = __decorate([
    (0, swagger_1.ApiTags)('health'),
    (0, common_1.Controller)('health'),
    __metadata("design:paramtypes", [config_1.ConfigService,
        prisma_service_1.PrismaService])
], HealthController);
//# sourceMappingURL=health.controller.js.map