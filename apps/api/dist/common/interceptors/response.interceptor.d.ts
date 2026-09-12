import { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
export interface ApiSuccessResponse<T> {
    success: true;
    data: T;
}
export declare class ResponseInterceptor<T> implements NestInterceptor<T, ApiSuccessResponse<T>> {
    intercept(_context: ExecutionContext, next: CallHandler<T>): Observable<ApiSuccessResponse<T>>;
}
