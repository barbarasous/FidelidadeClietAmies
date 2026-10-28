-- ============================================================================
-- Amies Fidelidade — ESTRUTURA DE BACKUP
-- Rode UMA vez: Supabase > SQL Editor > New query > cole tudo > Run.
-- É seguro rodar de novo (usa "if not exists" / "or replace").
-- ============================================================================

-- 1) Tabela de pontos de restauração -----------------------------------------
create table if not exists public.fidelidade_backups (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  key         text        not null default 'loyalty-db',
  reason      text        not null default 'auto',
  user_count  integer,
  value       text        not null
);

create index if not exists fidelidade_backups_key_created_idx
  on public.fidelidade_backups (key, created_at desc);

-- 2) Segurança: o app pode INSERIR e LER backups, mas NUNCA alterar ou apagar --
alter table public.fidelidade_backups enable row level security;

drop policy if exists "backups_insert" on public.fidelidade_backups;
create policy "backups_insert" on public.fidelidade_backups
  for insert to anon, authenticated
  with check (key = 'loyalty-db' and length(value) < 5000000);

drop policy if exists "backups_select" on public.fidelidade_backups;
create policy "backups_select" on public.fidelidade_backups
  for select to anon, authenticated
  using (true);
-- (sem policy de update/delete = bloqueados para o app)

-- 3) Limpeza automática (roda sozinha a cada novo backup) ---------------------
--    * automáticos com +7 dias: mantém só o último de cada dia
--    * qualquer backup com +1 ano: removido
--    * manuais / "antes de excluir" / "corrompido": ficam até completar 1 ano
create or replace function public.fidelidade_prune_backups()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.fidelidade_backups b
   where b.key = new.key
     and b.reason in ('auto', 'trigger')
     and b.created_at < now() - interval '7 days'
     and b.id not in (
       select distinct on ((created_at at time zone 'America/Sao_Paulo')::date) id
         from public.fidelidade_backups
        where key = new.key and reason in ('auto', 'trigger')
        order by (created_at at time zone 'America/Sao_Paulo')::date, created_at desc
     );

  delete from public.fidelidade_backups
   where key = new.key
     and created_at < now() - interval '365 days';

  return null;
end;
$$;

drop trigger if exists fidelidade_backups_prune on public.fidelidade_backups;
create trigger fidelidade_backups_prune
  after insert on public.fidelidade_backups
  for each row execute function public.fidelidade_prune_backups();

-- 4) Camada extra NO BANCO: guarda a versão antiga em TODA alteração/exclusão --
--    Funciona mesmo que o app tenha um bug ou que alguém apague o registro direto.
create or replace function public.fidelidade_archive_old_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  begin
    n := jsonb_array_length(old.value::jsonb -> 'users');
  exception when others then
    n := null;
  end;

  if tg_op = 'DELETE' then
    insert into public.fidelidade_backups (key, reason, user_count, value)
    values (old.key, 'trigger-delete', n, old.value::text);
    return old;
  end if;

  if old.value::text is distinct from new.value::text then
    insert into public.fidelidade_backups (key, reason, user_count, value)
    values (old.key, 'trigger', n, old.value::text);
  end if;
  return new;
end;
$$;

drop trigger if exists fidelidade_store_archive on public.fidelidade_store;
create trigger fidelidade_store_archive
  before update or delete on public.fidelidade_store
  for each row execute function public.fidelidade_archive_old_row();

-- 5) Primeiro ponto de restauração AGORA, com os dados atuais -----------------
insert into public.fidelidade_backups (key, reason, user_count, value)
select key,
       'manual',
       (select jsonb_array_length(value::jsonb -> 'users')),
       value::text
  from public.fidelidade_store
 where key = 'loyalty-db';

-- 6) Conferência (deve listar pelo menos 1 linha) -----------------------------
select id, created_at, reason, user_count
  from public.fidelidade_backups
 order by created_at desc
 limit 5;
