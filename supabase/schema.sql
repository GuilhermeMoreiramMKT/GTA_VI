create table if not exists public.trends (
 id text primary key,title text not null,description text not null default '',url text not null,source text not null,channel text not null default '',published_at timestamptz,views bigint not null default 0,likes bigint not null default 0,comments bigint not null default 0,thumbnail text not null default '',score integer not null default 0,category text not null default '',updated_at timestamptz not null default now()
);
create table if not exists public.drafts (
 id uuid primary key default gen_random_uuid(),trend_id text not null,title text not null,script text not null,caption text not null,source_url text not null,created_at timestamptz not null default now()
);
alter table public.trends enable row level security;
alter table public.drafts enable row level security;
