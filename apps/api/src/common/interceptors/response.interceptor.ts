import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

/**
 * Wraps every successful controller response in the standard FBEDS API
 * envelope: { success: true, data: <whatever the controller returned> }.
 *
 * Controllers stay simple — they just return their DTO/object — this
 * interceptor is the single place the envelope shape is applied, so it
 * can't drift between endpoints as more get added in later phases.
 */
@Injectable()
export class ResponseInterceptor<T>
  implements NestInterceptor<T, ApiSuccessResponse<T>>
{
  intercept(
    _context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiSuccessResponse<T>> {
    return next.handle().pipe(
      map((data) => ({
        success: true as const,
        data,
      })),
    );
  }
}
