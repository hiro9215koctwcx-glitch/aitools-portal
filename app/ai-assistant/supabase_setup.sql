-- AIアシスタント日本語版（ログインなし・デモ用）Supabase 初期設定
create extension if not exists vector;

create table if not exists public.document_chunks (
  id bigserial primary key,
  document_name text not null,
  chunk_index int not null default 0,
  content text not null,
  embedding vector(1536),
  created_at timestamptz not null default now()
);

create table if not exists public.memories (
  id bigserial primary key,
  summary text not null,
  embedding vector(1536),
  created_at timestamptz not null default now()
);

create or replace function public.match_document_chunks(query_embedding vector(1536), match_count int default 5)
returns table (id bigint, document_name text, chunk_index int, content text, similarity float)
language sql stable as $$
  select c.id, c.document_name, c.chunk_index, c.content,
         1 - (c.embedding <=> query_embedding) as similarity
  from public.document_chunks c
  where c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function public.match_memories(query_embedding vector(1536), match_count int default 3)
returns table (id bigint, summary text, created_at timestamptz, similarity float)
language sql stable as $$
  select m.id, m.summary, m.created_at,
         1 - (m.embedding <=> query_embedding) as similarity
  from public.memories m
  where m.embedding is not null
  order by m.embedding <=> query_embedding
  limit match_count;
$$;

alter table public.document_chunks enable row level security;
alter table public.memories enable row level security;

-- デモ用：ログインなし（anonキー）で読み書き・削除を許可
drop policy if exists "demo all document_chunks" on public.document_chunks;
create policy "demo all document_chunks" on public.document_chunks
  for all to anon, authenticated using (true) with check (true);

drop policy if exists "demo all memories" on public.memories;
create policy "demo all memories" on public.memories
  for all to anon, authenticated using (true) with check (true);

grant select, insert, update, delete on public.document_chunks, public.memories to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;
grant execute on function public.match_document_chunks(vector, int), public.match_memories(vector, int) to anon, authenticated;
