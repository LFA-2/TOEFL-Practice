-- Listening (lcr, conv, ann, talk) and typed speaking (rep, interview) items.
alter table public.items drop constraint if exists items_type_check;
alter table public.items add constraint items_type_check
  check (type in ('ctw', 'rdl', 'acad', 'lcr', 'conv', 'ann', 'talk', 'rep', 'interview', 'bas', 'email', 'disc'));
