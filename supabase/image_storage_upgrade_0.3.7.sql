-- Alex Board 0.3.7: reliable image delivery and HEIC support.
-- Run this entire file once in Supabase SQL Editor.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'board-assets',
  'board-assets',
  true,
  15728640,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']::text[]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Alex Board image uploads" on storage.objects;
create policy "Alex Board image uploads"
on storage.objects
for insert
to anon, authenticated
with check (bucket_id = 'board-assets');

select 'Alex Board 0.3.7 image storage installed' as result;
