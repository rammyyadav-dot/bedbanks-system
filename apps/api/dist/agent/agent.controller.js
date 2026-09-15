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
exports.AgentController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const current_user_decorator_1 = require("../auth/decorators/current-user.decorator");
const session_auth_guard_1 = require("../auth/guards/session-auth.guard");
const class_validator_1 = require("class-validator");
class SearchHotelsDto {
}
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], SearchHotelsDto.prototype, "destination", void 0);
__decorate([
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", String)
], SearchHotelsDto.prototype, "checkIn", void 0);
__decorate([
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", String)
], SearchHotelsDto.prototype, "checkOut", void 0);
__decorate([
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    __metadata("design:type", Number)
], SearchHotelsDto.prototype, "rooms", void 0);
__decorate([
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    __metadata("design:type", Number)
], SearchHotelsDto.prototype, "adults", void 0);
__decorate([
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(0),
    __metadata("design:type", Number)
], SearchHotelsDto.prototype, "children", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], SearchHotelsDto.prototype, "nationality", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], SearchHotelsDto.prototype, "currency", void 0);
let AgentController = class AgentController {
    context(identity) {
        return { user: identity.user, memberships: identity.memberships, capabilities: ['hotel.search', 'booking.read'] };
    }
    search(criteria, identity) {
        return {
            request: { ...criteria, currency: criteria.currency ?? 'USD' },
            tenantIds: identity.memberships.map((membership) => membership.tenantId),
            status: 'provider_unavailable',
            hotels: [],
            total: 0,
            message: 'No supplier adapter is configured for this environment. The request was authenticated and tenant-scoped.',
        };
    }
    finance(identity) {
        return {
            tenantIds: identity.memberships.map((membership) => membership.tenantId),
            status: 'not_configured',
            currency: 'USD',
            availableCredit: null,
            message: 'Credit and ledger data will be returned when the finance ledger is configured.',
        };
    }
};
exports.AgentController = AgentController;
__decorate([
    (0, common_1.Get)('context'),
    (0, swagger_1.ApiOperation)({ summary: 'Return the authenticated agent context and memberships' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], AgentController.prototype, "context", null);
__decorate([
    (0, common_1.Post)('search'),
    (0, swagger_1.ApiOperation)({ summary: 'Search live hotel inventory through the configured supplier boundary' }),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [SearchHotelsDto, Object]),
    __metadata("design:returntype", void 0)
], AgentController.prototype, "search", null);
__decorate([
    (0, common_1.Get)('finance/summary'),
    (0, swagger_1.ApiOperation)({ summary: 'Return the authenticated tenant finance capability status' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], AgentController.prototype, "finance", null);
exports.AgentController = AgentController = __decorate([
    (0, swagger_1.ApiTags)('agent'),
    (0, common_1.Controller)('agent'),
    (0, common_1.UseGuards)(session_auth_guard_1.SessionAuthGuard)
], AgentController);
//# sourceMappingURL=agent.controller.js.map