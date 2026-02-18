# Mirror Mirror: Campus Picture Platform

Landing page + email auth + one core product:
- Student picture posting for campus outfit moments
- Steeze Score valuation model for posts
- Profile management

Tech stack:
- React (Vite)
- Supabase (Auth + Postgres)
- Cloudinary (image upload)

## 1) Setup

1. Copy `.env.example` to `.env`.
2. Fill in your Supabase and Cloudinary values.
3. Install and run:

```bash
npm install
npm run dev
```

## 2) Supabase SQL

Run this in Supabase SQL editor:

```sql
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  username text,
  bio text,
  avatar_url text,
  style_tags text[] default '{}'
);

create table if not exists public.picture_posts (
  id text primary key,
  user_id uuid references auth.users(id) on delete cascade,
  image_url text not null,
  caption text,
  event_type text not null,
  tags text[] default '{}',
  likes_count int default 0,
  steeze_score int default 0,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;
alter table public.picture_posts enable row level security;

create policy "profiles_select_own" on public.profiles
for select using (auth.uid() = id);
create policy "profiles_upsert_own" on public.profiles
for insert with check (auth.uid() = id);
create policy "profiles_update_own" on public.profiles
for update using (auth.uid() = id);

create policy "posts_public_read" on public.picture_posts
for select using (true);
create policy "posts_insert_own" on public.picture_posts
for insert with check (auth.uid() = user_id);
```

## 3) Notes

- In development without env vars, the app can run in preview mode.
- For production auth, use Supabase email/password and optionally email confirmations.
- Cloudinary upload uses unsigned upload preset.
