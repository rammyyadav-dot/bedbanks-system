import { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
export interface ApiErrorResponse {
    success: false;
    error: {
        code: string;
        message: string;
        details: unknown[];
    };
    meta: {
        timestamp: string;
        path: string;
        requestId: string;
    };
}
export declare class HttpExceptionFilter implements ExceptionFilter {
    private readonly logger;
    catch(exception: unknown, host: ArgumentsHost): void;
    private resolveException;
}
