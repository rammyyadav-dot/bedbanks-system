export interface ApiResponse<T = any> {
  statusCode: number;
  message: string;
  data?: T;
  timestamp: string;
  path?: string;
}

export interface PaginatedResponse<T = any> {
  statusCode: number;
  message: string;
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
  timestamp: string;
}
