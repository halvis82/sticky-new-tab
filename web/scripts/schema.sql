-- Everything the notes need, safe to run again.

create table if not exists public.notes (
  id         text primary key,
  html       text not null default '',
  color      text not null default '#fff5a5',
  fx         double precision not null default 0.1,
  fy         double precision not null default 0.1,
  w          integer not null default 220,
  h          integer not null default 200,
  z          integer not null default 1,
  collapsed  boolean not null default false,
  deleted    boolean not null default false,
  u          bigint not null default 0,  -- client edit time in ms, newest wins
  origin     text,                       -- which open page wrote it, so it can skip its own echo
  updated_at timestamptz not null default now()
);

-- Typed in the note's bar. Empty means the bar shows the first line instead.
alter table public.notes add column if not exists title text not null default '';

-- Where the note sits in the lists, highest first. Dragging a note in a list changes it. Notes
-- from before it existed keep the order they had (newest edit first), and u goes up by one so
-- every device takes the new value.
alter table public.notes add column if not exists ord double precision not null default 0;
update public.notes set ord = u, u = u + 1 where ord = 0 and not deleted;

-- When what the note says last changed, which the lists show. u also moves when a note is only
-- moved, so it cannot say that.
alter table public.notes add column if not exists edited bigint not null default 0;
update public.notes set edited = u, u = u + 1 where edited = 0 and not deleted;

-- Pinned notes sit above the rest in the lists on the site. The new tab ignores it.
alter table public.notes add column if not exists pinned boolean not null default false;

-- Shown over most of the screen on the board, until shrunk back to where it was.
alter table public.notes add column if not exists expanded boolean not null default false;

-- A write older than the row it would replace is dropped, so a device that was offline
-- cannot roll back what happened elsewhere in the meantime.
create or replace function public.notes_newest_wins() returns trigger
language plpgsql as $$
begin
  if new.u < old.u then
    return null;
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists notes_newest_wins on public.notes;
create trigger notes_newest_wins before update on public.notes
  for each row execute function public.notes_newest_wins();

-- Only the notes account, which every device signs in to once with the password. The public
-- key alone reads nothing. Signing up makes other accounts, so the check is the address.
create or replace function public.is_owner() returns boolean
language sql stable as $$
  select coalesce(auth.jwt() ->> 'email', '') = 'notes@example.invalid' -- the email in config.js
$$;

alter table public.notes enable row level security;
drop policy if exists "open notes" on public.notes;
drop policy if exists "owner notes" on public.notes;
create policy "owner notes" on public.notes
  for all to authenticated using (public.is_owner()) with check (public.is_owner());

do $$
begin
  alter publication supabase_realtime add table public.notes;
exception when duplicate_object then null;
end $$;

-- Images and files: private. The clients fetch them with the session and show the copy.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('images', 'images', false, 26214400, array['image/*'])
on conflict (id) do update set public = false;

drop policy if exists "read note media" on storage.objects;
create policy "read note media" on storage.objects
  for select to authenticated using (bucket_id in ('images', 'files') and public.is_owner());

drop policy if exists "add note images" on storage.objects;
create policy "add note images" on storage.objects
  for insert to authenticated with check (bucket_id = 'images' and public.is_owner());

-- Attached files: any type, up to 25 MB each.
insert into storage.buckets (id, name, public, file_size_limit)
values ('files', 'files', false, 26214400)
on conflict (id) do update set public = false;

drop policy if exists "add note files" on storage.objects;
create policy "add note files" on storage.objects
  for insert to authenticated with check (bucket_id = 'files' and public.is_owner());

-- A twin table for the end to end tests, so they never touch real notes.
create table if not exists public.notes_test (like public.notes including all);
alter table public.notes_test add column if not exists title text not null default '';
alter table public.notes_test add column if not exists ord double precision not null default 0;
alter table public.notes_test add column if not exists edited bigint not null default 0;
alter table public.notes_test add column if not exists pinned boolean not null default false;
alter table public.notes_test add column if not exists expanded boolean not null default false;
drop trigger if exists notes_newest_wins on public.notes_test;
create trigger notes_newest_wins before update on public.notes_test
  for each row execute function public.notes_newest_wins();
alter table public.notes_test enable row level security;
drop policy if exists "open notes" on public.notes_test;
drop policy if exists "owner notes" on public.notes_test;
create policy "owner notes" on public.notes_test
  for all to authenticated using (public.is_owner()) with check (public.is_owner());
do $$
begin
  alter publication supabase_realtime add table public.notes_test;
exception when duplicate_object then null;
end $$;

-- History: notes deleted and text taken out of notes, so either can be brought back. Rows are
-- written once by the device that made the change and removed when someone clears them.
-- Ninety days and the newest 500 are kept; older ones go when a new one comes in.
create or replace function public.note_history_prune() returns trigger
language plpgsql as $$
begin
  execute format(
    'delete from %I where at < (extract(epoch from now()) * 1000)::bigint - 7776000000
       or id in (select id from %I order by at desc offset 500)',
    tg_table_name, tg_table_name);
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['note_history', 'notes_test_history'] loop
    execute format($f$
      create table if not exists public.%I (
        id         text primary key,
        note_id    text not null,
        kind       text not null,            -- 'deleted' or 'removed'
        at         bigint not null,          -- when, in ms
        html       text not null default '', -- the whole note as it was before
        removed    text not null default '', -- the text that went, for the list
        marks      jsonb,                    -- [[start, end], ...] of it in the note's text
        media      jsonb,                    -- images and files that went
        snap       jsonb,                    -- color, place and size, to bring a note back
        origin     text,
        created_at timestamptz not null default now()
      )$f$, t);
    execute format('create index if not exists %I on public.%I (at desc)', t || '_at', t);
    execute format('drop trigger if exists prune on public.%I', t);
    execute format('create trigger prune after insert on public.%I
      for each statement execute function public.note_history_prune()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "open history" on public.%I', t);
    execute format('drop policy if exists "owner history" on public.%I', t);
    execute format('create policy "owner history" on public.%I
      for all to authenticated using (public.is_owner()) with check (public.is_owner())', t);
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
