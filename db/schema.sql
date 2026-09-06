-- PostgreSQL reference schema. No live connection is configured in this phase.
create table tenants (id uuid primary key, code text unique not null, name text not null, tier text not null, status text not null default 'active', created_at timestamptz not null default now());
create table users (id uuid primary key, email text unique not null, display_name text not null, created_at timestamptz not null default now());
create table roles (id uuid primary key, key text unique not null, name text not null);
create table permissions (id uuid primary key, key text unique not null, name text not null);
create table memberships (tenant_id uuid not null references tenants(id), user_id uuid not null references users(id), role_id uuid not null references roles(id), created_at timestamptz not null default now(), primary key (tenant_id, user_id));
create table role_permissions (role_id uuid not null references roles(id), permission_id uuid not null references permissions(id), primary key (role_id, permission_id));
create table hotel_master (id uuid primary key, tenant_id uuid not null references tenants(id), giata_code text not null, name text not null, city text, country_code text, status text not null default 'active', unique (tenant_id, giata_code));
create table api_clients (id uuid primary key, tenant_id uuid not null references tenants(id), name text not null, client_id text unique not null, status text not null default 'active', last_seen_at timestamptz);
create table tenant_settings (tenant_id uuid primary key references tenants(id), settings jsonb not null default '{}');
create table audit_events (id uuid primary key, tenant_id uuid not null references tenants(id), actor_user_id uuid references users(id), action text not null, resource_type text not null, resource_id text, metadata jsonb not null default '{}', created_at timestamptz not null default now());
create index memberships_user_idx on memberships(user_id);
create index hotel_master_tenant_idx on hotel_master(tenant_id, status);
create index api_clients_tenant_idx on api_clients(tenant_id, status);
create index audit_events_tenant_time_idx on audit_events(tenant_id, created_at desc);
-- Every tenant-owned relation carries tenant_id; production queries must scope by request tenant context.
