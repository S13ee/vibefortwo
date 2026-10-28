-- =====================================================================
-- Vibe for Two · Supabase 설정
-- 기존 앱과 같은 Supabase 프로젝트를 함께 쓰기 위해 모든 이름 앞에 vft_ 를 붙였습니다.
-- Supabase 대시보드 > SQL Editor 에 전체를 붙여 넣고 Run 하세요. 여러 번 실행해도 안전합니다.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1. 표(table)
-- ---------------------------------------------------------------------

-- 멤버: 가입한 사람의 닉네임과 권한
--   pending = 가입 신청(승인 대기) / member = 멤버 / manager = 매니저 / admin = 관리자
create table if not exists public.vft_members (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid unique references auth.users(id) on delete cascade,
  name        text not null check (char_length(name) between 2 and 12),
  role        text not null default 'pending' check (role in ('pending','member','manager','admin')),
  sort        int  not null default 0,
  created_at  timestamptz not null default now()
);
create unique index if not exists vft_members_name_key on public.vft_members (lower(name));

-- 프로젝트
create table if not exists public.vft_projects (
  id          uuid primary key default gen_random_uuid(),
  no          int  not null unique,
  subtitle    text not null default '',
  start_date  date,
  end_date    date,
  created_at  timestamptz not null default now()
);

-- 멤버별 프로젝트 칸
create table if not exists public.vft_entries (
  project_id  uuid not null references public.vft_projects(id) on delete cascade,
  member_id   uuid not null references public.vft_members(id)  on delete cascade,
  title       text not null default '',
  topic       text not null default '',
  detail      text not null default '',
  url         text not null default '',
  plan        text not null default '',
  html        text not null default '',
  progress    int  not null default 0 check (progress between 0 and 100),
  updated_at  timestamptz not null default now(),
  primary key (project_id, member_id)
);

-- 완료 표시 (완료한 칸만 Works 에 보임)
alter table public.vft_entries add column if not exists done boolean not null default false;

-- 프로젝트 밖에서 올리는 개인 작업 (Works 페이지)
create table if not exists public.vft_works (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references public.vft_members(id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 80),
  topic       text not null default '',
  detail      text not null default '',
  url         text not null default '',
  html        text not null default '',
  image_path  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 노트
create table if not exists public.vft_notes (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.vft_projects(id) on delete cascade,
  author_id   uuid references public.vft_members(id) on delete set null,
  body        text not null check (char_length(body) between 1 and 4000),
  created_at  timestamptz not null default now()
);

-- 작업 자료 파일 (파일 자체는 Storage 의 vft-files 에 저장)
create table if not exists public.vft_files (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.vft_projects(id) on delete cascade,
  member_id   uuid not null references public.vft_members(id)  on delete cascade,
  name        text not null,
  size        bigint not null default 0,
  mime        text not null default '',
  path        text not null unique,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. 권한 확인용 함수
-- ---------------------------------------------------------------------

-- 지금 로그인한 사람의 멤버 id
create or replace function public.vft_my_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.vft_members where user_id = auth.uid()
$$;

-- 지금 로그인한 사람의 권한 단계: 0 방문자·승인 대기 / 1 멤버 / 2 매니저 / 3 관리자
create or replace function public.vft_my_level() returns int
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case role when 'admin' then 3 when 'manager' then 2 when 'member' then 1 else 0 end
    from public.vft_members where user_id = auth.uid()
  ), 0)
$$;

-- 닉네임 중복 확인 (가입 화면에서 사용)
create or replace function public.vft_nickname_available(n text) returns boolean
language sql stable security definer set search_path = public as $$
  select char_length(trim(n)) between 2 and 12
     and not exists (select 1 from public.vft_members where lower(name) = lower(trim(n)))
$$;

-- 이미 계정이 있는 사람(다른 앱에서 가입한 사람)이 로그인한 뒤 멤버 신청
create or replace function public.vft_request_join(n text) returns text
language plpgsql security definer set search_path = public as $$
declare nick text := trim(n);
begin
  if auth.uid() is null then return 'login'; end if;
  if exists (select 1 from public.vft_members where user_id = auth.uid()) then return 'exists'; end if;
  if char_length(nick) not between 2 and 12 then return 'invalid'; end if;
  if exists (select 1 from public.vft_members where lower(name) = lower(nick)) then return 'taken'; end if;
  insert into public.vft_members (user_id, name, role) values (auth.uid(), nick, 'pending');
  return 'ok';
end $$;

-- 사이트에서 가입하면 닉네임으로 가입 신청(pending) 행을 자동으로 만듭니다.
-- 같은 프로젝트의 다른 앱 가입에는 영향이 없습니다(vft_nickname 이 있을 때만 동작).
create or replace function public.vft_handle_signup() returns trigger
language plpgsql security definer set search_path = public as $$
declare nick text := nullif(trim(new.raw_user_meta_data ->> 'vft_nickname'), '');
begin
  if nick is not null then
    begin
      insert into public.vft_members (user_id, name, role) values (new.id, left(nick, 12), 'pending');
    exception when others then null;  -- 어떤 문제가 생겨도 기존 앱의 가입은 절대 막지 않도록
    end;
  end if;
  return new;
end $$;

drop trigger if exists vft_on_signup on auth.users;
create trigger vft_on_signup after insert on auth.users
  for each row execute function public.vft_handle_signup();

-- 멤버 행 보호: 계정 연결(user_id)은 바꿀 수 없음
create or replace function public.vft_members_guard() returns trigger
language plpgsql as $$
begin
  if current_user in ('authenticated', 'anon') and new.user_id is distinct from old.user_id then
    raise exception '계정 연결은 바꿀 수 없습니다';
  end if;
  return new;
end $$;
drop trigger if exists vft_members_guard on public.vft_members;
create trigger vft_members_guard before update on public.vft_members
  for each row execute function public.vft_members_guard();

-- 프로젝트 기간은 관리자만 바꿀 수 있음
create or replace function public.vft_projects_guard() returns trigger
language plpgsql as $$
begin
  if current_user in ('authenticated', 'anon') and public.vft_my_level() < 3
     and (new.start_date is distinct from old.start_date or new.end_date is distinct from old.end_date) then
    raise exception '프로젝트 기간은 관리자만 바꿀 수 있습니다';
  end if;
  return new;
end $$;
drop trigger if exists vft_projects_guard on public.vft_projects;
create trigger vft_projects_guard before update on public.vft_projects
  for each row execute function public.vft_projects_guard();

-- ---------------------------------------------------------------------
-- 3. 행 단위 권한(RLS)
-- ---------------------------------------------------------------------
alter table public.vft_members  enable row level security;
alter table public.vft_projects enable row level security;
alter table public.vft_entries  enable row level security;
alter table public.vft_notes    enable row level security;
alter table public.vft_files    enable row level security;
alter table public.vft_works    enable row level security;

-- 멤버: 승인된 멤버는 누구나 볼 수 있고, 가입 신청은 매니저 이상과 본인만 볼 수 있음
drop policy if exists vft_members_select on public.vft_members;
create policy vft_members_select on public.vft_members for select
  using (role <> 'pending' or public.vft_my_level() >= 2 or user_id = auth.uid());

-- 멤버 승인·이름 변경·삭제: 관리자는 모두, 매니저는 일반 멤버와 가입 신청만
drop policy if exists vft_members_update on public.vft_members;
create policy vft_members_update on public.vft_members for update to authenticated
  using      (public.vft_my_level() = 3 or (public.vft_my_level() = 2 and role in ('pending','member')))
  with check (public.vft_my_level() = 3 or (public.vft_my_level() = 2 and role in ('pending','member')));

drop policy if exists vft_members_delete on public.vft_members;
create policy vft_members_delete on public.vft_members for delete to authenticated
  using (public.vft_my_level() = 3 or (public.vft_my_level() = 2 and role in ('pending','member')));

-- 프로젝트: 누구나 보기 / 매니저 이상 만들기·부제 수정 / 관리자 삭제 (기간은 위 트리거가 관리자만 허용)
drop policy if exists vft_projects_select on public.vft_projects;
create policy vft_projects_select on public.vft_projects for select using (true);
drop policy if exists vft_projects_insert on public.vft_projects;
create policy vft_projects_insert on public.vft_projects for insert to authenticated
  with check (public.vft_my_level() >= 2);
drop policy if exists vft_projects_update on public.vft_projects;
create policy vft_projects_update on public.vft_projects for update to authenticated
  using (public.vft_my_level() >= 2) with check (public.vft_my_level() >= 2);
drop policy if exists vft_projects_delete on public.vft_projects;
create policy vft_projects_delete on public.vft_projects for delete to authenticated
  using (public.vft_my_level() = 3);

-- 멤버 칸: 누구나 보기 / 본인 칸은 본인이, 관리자는 전체
drop policy if exists vft_entries_select on public.vft_entries;
create policy vft_entries_select on public.vft_entries for select using (true);
drop policy if exists vft_entries_insert on public.vft_entries;
create policy vft_entries_insert on public.vft_entries for insert to authenticated
  with check (public.vft_my_level() = 3 or (public.vft_my_level() >= 1 and member_id = public.vft_my_id()));
drop policy if exists vft_entries_update on public.vft_entries;
create policy vft_entries_update on public.vft_entries for update to authenticated
  using      (public.vft_my_level() = 3 or (public.vft_my_level() >= 1 and member_id = public.vft_my_id()))
  with check (public.vft_my_level() = 3 or (public.vft_my_level() >= 1 and member_id = public.vft_my_id()));
drop policy if exists vft_entries_delete on public.vft_entries;
create policy vft_entries_delete on public.vft_entries for delete to authenticated
  using (public.vft_my_level() = 3);

-- 노트: 누구나 보기 / 멤버 이상 쓰기(작성자는 본인) / 본인 글 또는 매니저 이상 지우기
drop policy if exists vft_notes_select on public.vft_notes;
create policy vft_notes_select on public.vft_notes for select using (true);
drop policy if exists vft_notes_insert on public.vft_notes;
create policy vft_notes_insert on public.vft_notes for insert to authenticated
  with check (public.vft_my_level() >= 1 and author_id = public.vft_my_id());
drop policy if exists vft_notes_delete on public.vft_notes;
create policy vft_notes_delete on public.vft_notes for delete to authenticated
  using (public.vft_my_level() >= 2 or (public.vft_my_level() >= 1 and author_id = public.vft_my_id()));

-- 파일 기록: 누구나 보기 / 본인 칸에만 올리고 지우기, 관리자는 전체
drop policy if exists vft_files_select on public.vft_files;
create policy vft_files_select on public.vft_files for select using (true);
drop policy if exists vft_files_insert on public.vft_files;
create policy vft_files_insert on public.vft_files for insert to authenticated
  with check (public.vft_my_level() = 3 or (public.vft_my_level() >= 1 and member_id = public.vft_my_id()));
drop policy if exists vft_files_delete on public.vft_files;
create policy vft_files_delete on public.vft_files for delete to authenticated
  using (public.vft_my_level() = 3 or (public.vft_my_level() >= 1 and member_id = public.vft_my_id()));

-- 개인 작업: 누구나 보기 / 멤버 이상 본인 이름으로 올리기 / 본인 것만 수정·삭제, 관리자는 전체
drop policy if exists vft_works_select on public.vft_works;
create policy vft_works_select on public.vft_works for select using (true);
drop policy if exists vft_works_insert on public.vft_works;
create policy vft_works_insert on public.vft_works for insert to authenticated
  with check (public.vft_my_level() >= 1 and member_id = public.vft_my_id());
drop policy if exists vft_works_update on public.vft_works;
create policy vft_works_update on public.vft_works for update to authenticated
  using      (public.vft_my_level() = 3 or (public.vft_my_level() >= 1 and member_id = public.vft_my_id()))
  with check (public.vft_my_level() = 3 or (public.vft_my_level() >= 1 and member_id = public.vft_my_id()));
drop policy if exists vft_works_delete on public.vft_works;
create policy vft_works_delete on public.vft_works for delete to authenticated
  using (public.vft_my_level() = 3 or (public.vft_my_level() >= 1 and member_id = public.vft_my_id()));

-- ---------------------------------------------------------------------
-- 4. 접근 허용(grant)
-- ---------------------------------------------------------------------
grant usage on schema public to anon, authenticated;
grant select on public.vft_members, public.vft_projects, public.vft_entries, public.vft_notes, public.vft_files, public.vft_works to anon, authenticated;
grant insert, update, delete on public.vft_projects, public.vft_entries, public.vft_notes, public.vft_files, public.vft_works to authenticated;
grant update, delete on public.vft_members to authenticated;
grant execute on function public.vft_my_id(), public.vft_my_level(), public.vft_nickname_available(text) to anon, authenticated;
grant execute on function public.vft_request_join(text) to authenticated;

-- ---------------------------------------------------------------------
-- 5. 파일 저장소(Storage): vft-files, 공개 읽기, 파일당 10MB
--    경로 규칙: 프로젝트id/멤버id/파일이름, 개인 작업 이미지는 works/멤버id/파일이름
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('vft-files', 'vft-files', true, 10485760)
on conflict (id) do update set public = true, file_size_limit = 10485760;

drop policy if exists "vft files read" on storage.objects;
create policy "vft files read" on storage.objects for select
  using (bucket_id = 'vft-files');

drop policy if exists "vft files upload" on storage.objects;
create policy "vft files upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'vft-files' and (
    public.vft_my_level() = 3
    or (public.vft_my_level() >= 1 and (storage.foldername(name))[2] = public.vft_my_id()::text)));

drop policy if exists "vft files delete" on storage.objects;
create policy "vft files delete" on storage.objects for delete to authenticated
  using (bucket_id = 'vft-files' and (
    public.vft_my_level() = 3
    or (public.vft_my_level() >= 1 and (storage.foldername(name))[2] = public.vft_my_id()::text)));

-- =====================================================================
-- 6. 처음 한 번만: 사이트에서 BEE 로 가입한 뒤, 아래 한 줄만 따로 실행해 관리자로 지정하세요.
--    update public.vft_members set role = 'admin' where lower(name) = 'bee';
-- =====================================================================
