import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { REQUEST_USER_KEY } from '../auth.constants';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<Record<string, unknown>>();
    return request[REQUEST_USER_KEY] as AuthenticatedUser;
  },
);
