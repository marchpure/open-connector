create table identity_provider_config (
  id integer primary key check (id = 1),
  value text not null,
  updated_at text not null
);

create table access_policy_version (
  id integer primary key check (id = 1),
  version integer not null,
  updated_at text not null
);

insert into access_policy_version (id, version, updated_at)
values (1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

create table access_grants (
  id text primary key,
  subject_type text not null check (subject_type in ('user', 'group')),
  subject text not null,
  connection_id text not null,
  role text not null check (role in ('reader', 'operator', 'custom')),
  effect text not null check (effect in ('allow', 'deny')),
  custom_actions text not null default '[]',
  reason text,
  created_at text not null,
  updated_at text not null,
  revoked_at text
);

create index access_grants_subject_idx on access_grants (subject_type, subject);
create index access_grants_connection_idx on access_grants (connection_id);

create table identity_subjects (
  subject_key text primary key,
  value text not null,
  seen_at text not null
);

create table access_audit (
  id text primary key,
  subject_key text not null,
  connection_id text,
  action_id text,
  value text not null,
  created_at text not null
);

create index access_audit_created_at_idx on access_audit (created_at desc, id desc);
