"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var HttpExceptionFilter_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.HttpExceptionFilter = void 0;
const common_1 = require("@nestjs/common");
const STATUS_CODE_MAP = {
    [common_1.HttpStatus.BAD_REQUEST]: 'VALIDATION_ERROR',
    [common_1.HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
    [common_1.HttpStatus.FORBIDDEN]: 'FORBIDDEN',
    [common_1.HttpStatus.NOT_FOUND]: 'NOT_FOUND',
    [common_1.HttpStatus.CONFLICT]: 'CONFLICT',
    [common_1.HttpStatus.UNPROCESSABLE_ENTITY]: 'UNPROCESSABLE_ENTITY',
    [common_1.HttpStatus.INTERNAL_SERVER_ERROR]: 'INTERNAL_SERVER_ERROR',
};
let HttpExceptionFilter = HttpExceptionFilter_1 = class HttpExceptionFilter {
    constructor() {
        this.logger = new common_1.Logger(HttpExceptionFilter_1.name);
    }
    catch(exception, host) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse();
        const request = ctx.getRequest();
        const { status, code, message, details } = this.resolveException(exception);
        if (status >= common_1.HttpStatus.INTERNAL_SERVER_ERROR) {
            this.logger.error(`${request.method} ${request.url} -> ${status}`, exception instanceof Error ? exception.stack : undefined);
        }
        const errorResponse = {
            success: false,
            error: { code, message, details },
            meta: {
                timestamp: new Date().toISOString(),
                path: request.url,
                requestId: request.requestId ?? 'unknown',
            },
        };
        response.status(status).json(errorResponse);
    }
    resolveException(exception) {
        if (exception instanceof common_1.HttpException) {
            const status = exception.getStatus();
            const body = exception.getResponse();
            const code = STATUS_CODE_MAP[status] ?? 'HTTP_ERROR';
            if (typeof body === 'object' && body !== null && 'message' in body) {
                const rawMessage = body.message;
                const details = Array.isArray(rawMessage) ? rawMessage : [];
                const message = Array.isArray(rawMessage)
                    ? 'Request validation failed'
                    : String(rawMessage);
                return { status, code, message, details };
            }
            return {
                status,
                code,
                message: typeof body === 'string' ? body : exception.message,
                details: [],
            };
        }
        return {
            status: common_1.HttpStatus.INTERNAL_SERVER_ERROR,
            code: STATUS_CODE_MAP[common_1.HttpStatus.INTERNAL_SERVER_ERROR],
            message: 'An unexpected error occurred',
            details: [],
        };
    }
};
exports.HttpExceptionFilter = HttpExceptionFilter;
exports.HttpExceptionFilter = HttpExceptionFilter = HttpExceptionFilter_1 = __decorate([
    (0, common_1.Catch)()
], HttpExceptionFilter);
//# sourceMappingURL=http-exception.filter.js.map