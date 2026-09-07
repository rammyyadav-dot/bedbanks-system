import { SetMetadata } from '@nestjs/common';

export const Idempotent = () => SetMetadata('idempotent', true);
