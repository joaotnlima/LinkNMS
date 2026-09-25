-- Seed: "Casa Silva" (cowork/documentation/to-be/15-data-model.md, Part 2).
-- Ids are derived from readable aliases so rows can be cross-referenced by hand: id('org.silva').
CREATE SCHEMA IF NOT EXISTS seed;
CREATE OR REPLACE FUNCTION seed.id(alias text) RETURNS uuid LANGUAGE sql IMMUTABLE AS
$$ SELECT md5('linknms:' || alias)::uuid $$;

BEGIN;
-- identity ------------------------------------------------------------------------------
INSERT INTO identity.organization (id, clerk_org_id, kind, legal_name, nif) VALUES
 (seed.id('org.silva'),     'org_silva',     'household',  'Ana e Rui Silva', NULL),
 (seed.id('org.douro'),     'org_douro',     'contractor', 'Construções Douro, Lda.', '509111222'),
 (seed.id('org.canorte'),   'org_canorte',   'contractor', 'Canalizações Norte, Unip. Lda.', '514333444'),
 (seed.id('org.atlantico'), 'org_atlantico', 'contractor', 'Caixilharia Atlântico, Lda.', '516555666'),
 (seed.id('org.eletromota'),'org_eletromota','contractor', 'Eletro Mota — Nuno Mota', '212777888'),
 (seed.id('org.marta'),     'org_marta',     'consultant', 'Marta Sousa Arquitetura', '245999000'),
 (seed.id('org.alufer'),    'org_alufer',    'contractor', 'Alufer, Lda.', '517000111');

INSERT INTO identity.person (id, clerk_user_id, email, name) VALUES
 (seed.id('p.ana'),'user_ana','ana.silva@example.pt','Ana Silva'),
 (seed.id('p.rui'),'user_rui','rui.silva@example.pt','Rui Silva'),
 (seed.id('p.carlos'),'user_carlos','carlos@douro.example.pt','Carlos Pinto'),
 (seed.id('p.ines'),'user_ines','ines@douro.example.pt','Inês Costa'),
 (seed.id('p.jorge'),'user_jorge','jorge@canorte.example.pt','Jorge Faria'),
 (seed.id('p.sofia'),'user_sofia','sofia@atlantico.example.pt','Sofia Reis'),
 (seed.id('p.nuno'),'user_nuno','nuno@eletromota.example.pt','Nuno Mota'),
 (seed.id('p.marta'),'user_marta','marta@msarq.example.pt','Marta Sousa');

INSERT INTO identity.org_membership (org_id, person_id, org_role) VALUES
 (seed.id('org.silva'), seed.id('p.ana'), 'admin'),
 (seed.id('org.silva'), seed.id('p.rui'), 'representative'),
 (seed.id('org.douro'), seed.id('p.carlos'), 'admin'),
 (seed.id('org.douro'), seed.id('p.ines'), 'site_lead'),
 (seed.id('org.canorte'), seed.id('p.jorge'), 'admin'),
 (seed.id('org.atlantico'), seed.id('p.sofia'), 'admin'),
 (seed.id('org.eletromota'), seed.id('p.nuno'), 'admin'),
 (seed.id('org.marta'), seed.id('p.marta'), 'admin');

-- project ------------------------------------------------------------------------------
INSERT INTO project.project (id, owner_org_id, created_by_org_id, name, address, municipality_code, typology, gross_area_m2, indicative_budget_cents, status)
VALUES (seed.id('prj.silva'), seed.id('org.silva'), seed.id('org.silva'), 'Casa Silva — Lote 12', 'Lote 12, Maia', '1306', 'T3', 212.00, 13000000, 'in_execution');
INSERT INTO project.location VALUES
 (seed.id('loc.site'),  seed.id('prj.silva'), NULL, 'site','Lote 12','a'),
 (seed.id('loc.house'), seed.id('prj.silva'), seed.id('loc.site'),'building','Moradia','a'),
 (seed.id('loc.garage'),seed.id('prj.silva'), seed.id('loc.site'),'building','Garagem','b');
INSERT INTO project.calendar VALUES (seed.id('prj.silva'), '{1,2,3,4,5}', ARRAY[daterange('2026-08-10','2026-08-22')]);
INSERT INTO platform.holiday VALUES ('2026-06-24','1306','São João'),('2026-10-05','national','Implantação da República'),
 ('2026-12-01','national','Restauração da Independência'),('2026-12-08','national','Imaculada Conceição');

-- contracting --------------------------------------------------------------------------
INSERT INTO contracting.contract (id, project_id, kind, parent_contract_id, client_org_id, supplier_org_id, reference, specialties, scope_exclusions, payment_terms, retention_bp, contractual_start, contractual_end, revision, origin, origin_proposal_id, status, sponsored_by_org_id) VALUES
 (seed.id('ctr.prime'), seed.id('prj.silva'),'prime',NULL, seed.id('org.silva'), seed.id('org.douro'),'C-2026-014','{structure,masonry,roofing,windows,plumbing,flooring}','Instalação elétrica e ITED excluídas','measurement_monthly',500,'2026-05-04','2026-12-18',2,'award',seed.id('prop.douro'),'active',NULL),
 (seed.id('ctr.elec'),  seed.id('prj.silva'),'direct',NULL, seed.id('org.silva'), seed.id('org.eletromota'),'C-2026-015','{electrical}',NULL,'milestones',500,'2026-09-02','2026-10-30',1,'direct_entry',NULL,'active',NULL),
 (seed.id('ctr.arch'),  seed.id('prj.silva'),'service',NULL, seed.id('org.silva'), seed.id('org.marta'),'C-2026-003','{architecture}',NULL,'milestones',0,NULL,NULL,1,'direct_entry',NULL,'active',NULL),
 (seed.id('ctr.sub.plumb'), seed.id('prj.silva'),'sub',seed.id('ctr.prime'), seed.id('org.douro'), seed.id('org.canorte'),'D-SUB-031','{plumbing}',NULL,'milestones',500,'2026-08-31','2026-09-10',1,'direct_entry',NULL,'signed',seed.id('org.douro')),
 (seed.id('ctr.sub.win'),   seed.id('prj.silva'),'sub',seed.id('ctr.prime'), seed.id('org.douro'), seed.id('org.atlantico'),'D-SUB-032','{windows}',NULL,'milestones',500,'2026-09-28','2026-10-16',2,'award',seed.id('prop.atlantico'),'signed',NULL);

-- project participation derived from contracts
INSERT INTO project.participation (project_id, org_id, capacity, source, contract_id) VALUES
 (seed.id('prj.silva'), seed.id('org.silva'),'owner','project',NULL);
INSERT INTO project.participation (project_id, org_id, capacity, source, contract_id)
SELECT project_id, supplier_org_id,
       CASE kind WHEN 'prime' THEN 'prime_contractor' WHEN 'direct' THEN 'direct_contractor' WHEN 'sub' THEN 'subcontractor' ELSE 'consultant' END,
       'contract', id FROM contracting.contract;

-- planning: rows ------------------------------------------------------------------------
-- helper: t(alias, parent, depth, pos, kind, name, specialty, location, contract, assignee, mode, start, finish, wd, a_start, a_finish, bl_start, bl_finish, state)
CREATE TEMP TABLE t_in (a text, parent text, depth int, pos text, kind text, name text, spec text, loc text, ctr text, asg text,
  mode text, s date, f date, wd int, as_ date, af date, bs date, bf date, state text);
INSERT INTO t_in VALUES
 ('T-010',NULL,1,'a','summary','Licenciamento',NULL,'loc.site',NULL,'org.silva','dated','2026-02-16','2026-04-10',NULL,'2026-02-16','2026-04-10',NULL,NULL,'planned'),
 ('T-011','T-010',2,'a','task','Submeter pedido de licença',NULL,'loc.site',NULL,'org.silva','dated','2026-02-16','2026-02-16',1,'2026-02-16','2026-02-16',NULL,NULL,'planned'),
 ('T-012','T-010',2,'b','task','Apreciação pela Câmara',NULL,'loc.site',NULL,'org.silva','external','2026-02-17',NULL,NULL,'2026-02-17','2026-04-10',NULL,NULL,'planned'),
 ('T-013','T-010',2,'c','milestone','Alvará de construção emitido',NULL,'loc.site',NULL,'org.silva','dated','2026-04-10','2026-04-10',0,'2026-04-10','2026-04-10',NULL,NULL,'planned'),
 ('T-014',NULL,1,'b','task','Ligação definitiva à rede elétrica (E-Redes)','electrical','loc.site',NULL,'org.silva','undated',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'planned'),
 ('T-100',NULL,1,'c','summary','Estrutura','structure','loc.house','ctr.prime','org.douro','dated','2026-05-04','2026-07-24',NULL,'2026-05-04','2026-07-24','2026-05-04','2026-07-17','extended'),
 ('T-110','T-100',2,'a','task','Escavação','earthworks','loc.site',NULL,'org.douro','dated','2026-05-04','2026-05-14',9,'2026-05-04','2026-05-14','2026-05-04','2026-05-15','on_baseline'),
 ('T-120','T-100',2,'b','task','Fundações','structure','loc.house',NULL,'org.douro','dated','2026-05-18','2026-06-10',17,'2026-05-18','2026-06-10','2026-05-18','2026-06-05','extended'),
 ('T-130','T-100',2,'c','task','Estrutura betão armado','structure','loc.house',NULL,'org.douro','dated','2026-06-11','2026-07-24',32,'2026-06-11','2026-07-24','2026-06-08','2026-07-17','extended'),
 ('T-200',NULL,1,'d','task','Alvenarias','masonry','loc.house','ctr.prime','org.douro','dated','2026-07-27','2026-09-11',30,'2026-07-27',NULL,'2026-07-20','2026-08-28','extended'),
 ('T-300',NULL,1,'e','task','Cobertura','roofing','loc.house','ctr.prime','org.douro','dated','2026-08-31','2026-09-25',20,'2026-08-31',NULL,'2026-08-31','2026-09-25','on_baseline'),
 ('T-400',NULL,1,'f','task','Canalização — tubagem embebida','plumbing','loc.house','ctr.sub.plumb','org.canorte','dated','2026-09-14','2026-09-24',9,NULL,NULL,'2026-08-31','2026-09-10','extended'),
 ('T-450',NULL,1,'g','task','Eletricidade — tubagem embebida','electrical','loc.house','ctr.elec','org.eletromota','dated','2026-09-16','2026-10-01',12,NULL,NULL,'2026-09-02','2026-09-17','extended'),
 ('T-500',NULL,1,'h','summary','Caixilharia','windows','loc.house','ctr.sub.win','org.atlantico','dated','2026-09-28','2026-10-16',NULL,NULL,NULL,'2026-09-28','2026-10-16','on_baseline'),
 ('T-510','T-500',2,'a','task','Medição de vãos','windows','loc.house',NULL,'org.atlantico','dated','2026-09-28','2026-09-29',2,NULL,NULL,'2026-09-28','2026-09-29','on_baseline'),
 ('T-520','T-500',2,'b','task','Fabrico e montagem','windows','loc.house',NULL,'org.atlantico','dated','2026-09-30','2026-10-16',12,NULL,NULL,'2026-09-30','2026-10-16','on_baseline'),
 ('T-600',NULL,1,'i','task','Pavimentos','flooring','loc.house','ctr.prime','org.douro','dated','2026-10-19','2026-11-27',30,NULL,NULL,'2026-10-19','2026-11-27','on_baseline'),
 ('T-700',NULL,1,'j','task','Garagem — estrutura e cobertura','structure','loc.garage','ctr.prime','org.douro','dated','2026-09-21','2026-10-16',19,NULL,NULL,'2026-09-14','2026-10-09','extended'),
 ('M-900',NULL,1,'k','milestone','Receção provisória (empreitada)',NULL,'loc.site','ctr.prime','org.silva','dated','2026-12-18','2026-12-18',0,NULL,NULL,'2026-12-18','2026-12-18','on_baseline');

INSERT INTO planning.task (id, project_id, parent_id, depth, position, kind, name, specialty, location_id, contract_id,
  assignee_org_id, assignee_inherited, dating_mode, start, finish, duration_wd, actual_start, actual_finish,
  baseline_start, baseline_finish, schedule_state)
SELECT seed.id(a), seed.id('prj.silva'), CASE WHEN parent IS NULL THEN NULL ELSE seed.id(parent) END, depth, pos, kind, name, spec,
       seed.id(loc), CASE WHEN ctr IS NULL THEN NULL ELSE seed.id(ctr) END, seed.id(asg), parent IS NOT NULL, mode, s, f, wd, as_, af, bs, bf, state
FROM t_in ORDER BY depth;

-- materialise branch_contract_id = nearest ancestor-or-self contract_id
WITH RECURSIVE b AS (
  SELECT id, contract_id AS branch FROM planning.task WHERE parent_id IS NULL
  UNION ALL
  SELECT t.id, coalesce(t.contract_id, b.branch) FROM planning.task t JOIN b ON t.parent_id = b.id)
UPDATE planning.task t SET branch_contract_id = b.branch FROM b WHERE b.id = t.id;

INSERT INTO planning.link (id, project_id, predecessor_id, successor_id, from_anchor, to_anchor, lag_wd, created_by_org_id, created_by_person_id)
SELECT seed.id('lnk.'||p||'.'||s), seed.id('prj.silva'), seed.id(p), seed.id(s), fa, ta, lag, seed.id(o), seed.id(pe) FROM (VALUES
 ('T-011','T-012','end','start',0,'org.silva','p.ana'),
 ('T-012','T-013','end','end',0,'org.silva','p.ana'),
 ('T-013','T-110','end','start',0,'org.silva','p.ana'),
 ('T-110','T-120','end','start',0,'org.douro','p.ines'),
 ('T-120','T-130','end','start',0,'org.douro','p.ines'),
 ('T-130','T-200','end','start',0,'org.douro','p.ines'),
 ('T-130','T-300','end','start',0,'org.douro','p.ines'),
 ('T-200','T-400','end','start',0,'org.douro','p.carlos'),
 ('T-400','T-450','start','start',2,'org.silva','p.ana'),
 ('T-510','T-520','end','start',0,'org.atlantico','p.sofia')) v(p,s,fa,ta,lag,o,pe);

-- cost lines (BoQ on tasks) -------------------------------------------------------------
INSERT INTO contracting.boq_item (id, project_id, contract_id, estimate_owner_org_id, task_id, code, description, unit, quantity, unit_price_cents, material_spec, parent_boq_item_id, introduced_by_change_order_id, superseded_by_change_order_id)
SELECT seed.id('boq.'||c||'.'||code), seed.id('prj.silva'), CASE WHEN c='est' THEN NULL ELSE seed.id(c) END,
       CASE WHEN c='est' THEN seed.id('org.silva') END, seed.id(task), code, d, u, q, p, m,
       CASE WHEN par IS NULL THEN NULL ELSE seed.id(par) END,
       CASE WHEN intro IS NULL THEN NULL ELSE seed.id(intro) END,
       CASE WHEN sup IS NULL THEN NULL ELSE seed.id(sup) END
FROM (VALUES
 ('ctr.prime','1.1','T-110','Escavação geral','m3',120.000,1800,NULL,NULL,NULL,NULL),
 ('ctr.prime','2.1','T-120','Betão em fundações','m3',45.000,14500,NULL,NULL,NULL,NULL),
 ('ctr.prime','2.2','T-130','Estrutura em betão armado','m3',60.000,32000,NULL,NULL,NULL,NULL),
 ('ctr.prime','3.1','T-200','Alvenaria de tijolo 30 cm','m2',380.000,3200,NULL,NULL,NULL,NULL),
 ('ctr.prime','4.1','T-300','Cobertura c/ isolamento XPS 80','m2',160.000,8500,NULL,NULL,NULL,NULL),
 ('ctr.prime','5.1','T-400','Redes de águas e esgotos','vg',1.000,980000,NULL,NULL,NULL,NULL),
 ('ctr.prime','6.1','T-520','Caixilharia alumínio c/ corte térmico','m2',42.000,41000,NULL,NULL,NULL,'co.p1'),
 ('ctr.prime','6.1a','T-520','Caixilharia alumínio c/ corte térmico','m2',48.000,41000,NULL,NULL,'co.p1',NULL),
 ('ctr.prime','7.1','T-600','Pavimento cerâmico','m2',180.000,4800,NULL,NULL,NULL,NULL),
 ('ctr.sub.plumb','P.1','T-400','Redes de águas e esgotos (MO + material)','vg',1.000,760000,NULL,'boq.ctr.prime.5.1',NULL,NULL),
 ('ctr.sub.win','W.1','T-520','Caixilharia — fornecimento e montagem','m2',42.000,33000,'Série 45 RPT','boq.ctr.prime.6.1',NULL,'co.s1'),
 ('ctr.sub.win','W.1a','T-520','Caixilharia — fornecimento e montagem','m2',48.000,33000,'Série 60 RPT','boq.ctr.prime.6.1a','co.s1',NULL),
 ('ctr.elec','E.1','T-450','Instalação elétrica','vg',1.000,1150000,NULL,NULL,NULL,NULL),
 ('ctr.elec','E.2','T-450','ITED','vg',1.000,230000,NULL,NULL,NULL,NULL),
 ('est','EST.1','T-014','Ramal E-Redes (estimativa)','vg',1.000,120000,NULL,NULL,NULL,NULL)
) v(c,code,task,d,u,q,p,m,par,intro,sup)
ORDER BY (par IS NOT NULL);

UPDATE contracting.contract c SET value_cents = s.v FROM (
  SELECT contract_id, sum(round(quantity*unit_price_cents))::bigint v FROM contracting.boq_item
  WHERE contract_id IS NOT NULL AND superseded_by_change_order_id IS NULL GROUP BY 1) s WHERE s.contract_id = c.id;
UPDATE contracting.contract SET value_cents = 900000 WHERE id = seed.id('ctr.arch');

INSERT INTO contracting.change_order (id, contract_id, number, kind, reason, amount_delta_cents, linked_change_order_id, proposed_by_org_id, proposed_by_person_id, decided_by_org_id, decided_by_person_id, decided_at, status) VALUES
 (seed.id('co.s1'), seed.id('ctr.sub.win'),'CO-S-001','scope_and_time','Extra patio door, living room → garden (6 m²)',198000,NULL, seed.id('org.atlantico'), seed.id('p.sofia'), seed.id('org.douro'), seed.id('p.carlos'),'2026-09-15 18:05+01','approved'),
 (seed.id('co.p1'), seed.id('ctr.prime'),'CO-P-001','scope_and_time','Extra patio door, living room → garden (6 m²)',246000,seed.id('co.s1'), seed.id('org.douro'), seed.id('p.carlos'), seed.id('org.silva'), seed.id('p.ana'),'2026-09-17 21:40+01','approved');

INSERT INTO contracting.measurement VALUES (seed.id('ms.prime.2026-07'), seed.id('ctr.prime'),'2026-07','approved',1088000,54400,1033600, seed.id('p.carlos'), seed.id('p.ana'),'2026-08-05 10:00+01');
INSERT INTO contracting.measurement_line VALUES
 (seed.id('ms.prime.2026-07'), seed.id('boq.ctr.prime.2.2'), 30.000),
 (seed.id('ms.prime.2026-07'), seed.id('boq.ctr.prime.3.1'), 40.000);
INSERT INTO contracting.payment_record (id, contract_id, measurement_id, milestone_label, amount_cents, due_date, status, declared_paid_at, declared_by_person_id, confirmed_at, confirmed_by_person_id) VALUES
 (seed.id('pay.2026-07'), seed.id('ctr.prime'), seed.id('ms.prime.2026-07'), NULL, 1033600, '2026-09-04', 'confirmed', '2026-08-20 09:00+01', seed.id('p.rui'), '2026-08-21 09:12+01', seed.id('p.carlos')),
 (seed.id('pay.2026-08'), seed.id('ctr.prime'), NULL, 'Auto 2026-08', 1216000, '2026-10-05', 'expected', NULL, NULL, NULL, NULL),
 (seed.id('pay.elec.1'), seed.id('ctr.elec'), NULL, 'Tubagem embebida', 437000, '2026-09-30', 'expected', NULL, NULL, NULL, NULL);

-- baselines --------------------------------------------------------------------------------
INSERT INTO planning.baseline (id, project_id, contract_id, version, reason, change_order_id, taken_at) VALUES
 (seed.id('bl.prime.1'), seed.id('prj.silva'), seed.id('ctr.prime'), 1, 'contract_signed', NULL, '2026-04-20 11:02+01'),
 (seed.id('bl.elec.1'),  seed.id('prj.silva'), seed.id('ctr.elec'),  1, 'contract_signed', NULL, '2026-04-28 10:00+01'),
 (seed.id('bl.plumb.1'), seed.id('prj.silva'), seed.id('ctr.sub.plumb'), 1, 'contract_signed', NULL, '2026-06-12 15:20+01'),
 (seed.id('bl.win.1'),   seed.id('prj.silva'), seed.id('ctr.sub.win'), 1, 'contract_signed', NULL, '2026-06-19 12:00+01'),
 (seed.id('bl.win.2'),   seed.id('prj.silva'), seed.id('ctr.sub.win'), 2, 'change_order', seed.id('co.s1'), '2026-09-15 18:05+01');
INSERT INTO planning.baseline_task (baseline_id, task_id, start, finish, duration_wd, name)
SELECT seed.id(b), seed.id(t), s::date, f::date, NULL, n FROM (VALUES
 ('bl.prime.1','T-200','2026-07-20','2026-08-28','Alvenarias'),
 ('bl.prime.1','T-700','2026-09-14','2026-10-09','Garagem — estrutura e cobertura'),
 ('bl.plumb.1','T-400','2026-08-31','2026-09-10','Canalização — tubagem embebida'),
 ('bl.elec.1','T-450','2026-09-02','2026-09-17','Eletricidade — tubagem embebida'),
 ('bl.win.1','T-520','2026-09-30','2026-10-09','Fabrico e montagem'),
 ('bl.win.2','T-520','2026-09-30','2026-10-16','Fabrico e montagem')) v(b,t,s,f,n);

-- progress (append-only) -------------------------------------------------------------------
INSERT INTO planning.progress_report (task_id, seq, status, percent, note, reported_by_org_id, reported_by_person_id, reported_at)
SELECT seed.id(t), sq, st, pc, nt, seed.id(o), seed.id(p), at::timestamptz FROM (VALUES
 ('T-130',1,'in_progress',10,'Cofragem pilares iniciada','org.douro','p.ines','2026-06-11 08:10+01'),
 ('T-130',2,'blocked',NULL,'Atraso na entrega de aço (fornecedor)','org.douro','p.ines','2026-06-24 17:40+01'),
 ('T-130',3,'in_progress',55,'Aço entregue','org.douro','p.ines','2026-06-29 09:05+01'),
 ('T-130',4,'done',NULL,'Laje de cobertura betonada','org.douro','p.ines','2026-07-22 16:30+01'),
 ('T-130',5,'verified',NULL,'Aceite: prumadas e recobrimentos conformes','org.silva','p.ana','2026-07-24 11:00+01'),
 ('T-200',1,'in_progress',20,NULL,'org.douro','p.ines','2026-07-27 08:00+01'),
 ('T-200',2,'in_progress',60,NULL,'org.douro','p.ines','2026-08-28 18:00+01'),
 ('T-200',3,'in_progress',85,'Faltam paredes da garagem','org.douro','p.ines','2026-09-21 17:15+01')) v(t,sq,st,pc,nt,o,p,at);

INSERT INTO quality.verification_request (id, task_id, requested_by_org_id, status, decided_by_org_id, decided_by_person_id, reason, decided_at) VALUES
 (seed.id('vr.T-130'), seed.id('T-130'), seed.id('org.douro'), 'accepted', seed.id('org.silva'), seed.id('p.ana'), NULL, '2026-07-24 11:00+01');

-- variations -------------------------------------------------------------------------------
INSERT INTO planning.variation (id, project_id, task_id, kind, scope_type, scope_id, baseline_value, current_value, delta, cause, cause_task_id, first_changed_at, last_changed_at, last_changed_by_org_id, status, change_order_id)
SELECT seed.id(v), seed.id('prj.silva'), seed.id(t), k, st, seed.id(sid), bv::jsonb, cv::jsonb, d::jsonb, c, CASE WHEN ct IS NULL THEN NULL ELSE seed.id(ct) END,
       fa::timestamptz, fa::timestamptz, seed.id(o), s, CASE WHEN co IS NULL THEN NULL ELSE seed.id(co) END FROM (VALUES
 ('V-01','T-200','time','project','prj.silva','{"finish":"2026-08-28"}','{"finish":"2026-09-11"}','{"finish_wd":10}','direct',NULL,'2026-09-02 17:58+01','org.douro','acknowledged',NULL),
 ('V-02','T-400','time','project','prj.silva','{"start":"2026-08-31","finish":"2026-09-10"}','{"start":"2026-09-14","finish":"2026-09-24"}','{"finish_wd":10}','propagated','T-200','2026-09-02 17:58+01','org.douro','open',NULL),
 ('V-03','T-450','time','project','prj.silva','{"start":"2026-09-02","finish":"2026-09-17"}','{"start":"2026-09-16","finish":"2026-10-01"}','{"finish_wd":10}','propagated','T-400','2026-09-02 17:58+01','org.douro','open',NULL),
 ('V-04','T-700','time','project','prj.silva','{"finish":"2026-10-09"}','{"finish":"2026-10-16"}','{"finish_wd":5}','direct',NULL,'2026-09-11 10:20+01','org.douro','open',NULL),
 ('V-05','T-520','cost','contract','ctr.prime','{"line":"6.1","qty":42}','{"line":"6.1a","qty":48}','{"amount_cents":246000}','direct',NULL,'2026-09-17 21:40+01','org.douro','formalised','co.p1'),
 ('V-06','T-520','cost','contract','ctr.sub.win','{"line":"W.1","qty":42}','{"line":"W.1a","qty":48}','{"amount_cents":198000}','direct',NULL,'2026-09-15 18:05+01','org.atlantico','formalised','co.s1'),
 ('V-07','T-520','material','contract','ctr.sub.win','{"spec":"Série 45 RPT"}','{"spec":"Série 60 RPT"}','{"amount_cents":0}','direct',NULL,'2026-09-18 09:30+01','org.atlantico','open',NULL)
) x(v,t,k,st,sid,bv,cv,d,c,ct,fa,o,s,co);
INSERT INTO planning.variation_ack VALUES (seed.id('V-01'), seed.id('org.silva'), seed.id('p.ana'), '2026-09-03 08:40+01');

-- tendering: sub-level RFP for windows with 3 lanes ------------------------------------------
INSERT INTO tendering.rfp (id, project_id, issuer_org_id, level, parent_contract_id, title, specialties, visibility, submission_deadline, status, awarded_proposal_id) VALUES
 (seed.id('rfp.win'), seed.id('prj.silva'), seed.id('org.douro'), 'sub', seed.id('ctr.prime'), 'Caixilharia — moradia', '{windows}', 'invite_only', '2026-05-29 18:00+01', 'awarded', seed.id('prop.atlantico'));
INSERT INTO tendering.rfp_root VALUES (seed.id('rfp.win'), seed.id('T-500'));
INSERT INTO tendering.rfp_recipient (id, rfp_id, org_id, email, token_hash, status, sent_at, opened_at) VALUES
 (seed.id('rr.atl'), seed.id('rfp.win'), seed.id('org.atlantico'), 'sofia@atlantico.example.pt', repeat('a',64), 'proposal_submitted', '2026-05-15 10:00+01', '2026-05-15 11:20+01'),
 (seed.id('rr.vid'), seed.id('rfp.win'), NULL, 'vendas@vidralux.example.pt', repeat('b',64), 'proposal_submitted', '2026-05-15 10:00+01', '2026-05-16 09:00+01'),
 (seed.id('rr.alu'), seed.id('rfp.win'), seed.id('org.alufer'), 'geral@alufer.example.pt', repeat('c',64), 'opened', '2026-05-15 10:00+01', '2026-05-21 14:00+01');
INSERT INTO tendering.proposal (id, rfp_id, recipient_id, bidder_org_id, channel, current_revision, status, summary_total_cents, summary_duration_wd, recorded_by_person_id) VALUES
 (seed.id('prop.atlantico'), seed.id('rfp.win'), seed.id('rr.atl'), seed.id('org.atlantico'), 'platform', 1, 'awarded', 1386000, 9, NULL),
 (seed.id('prop.vidralux'),  seed.id('rfp.win'), seed.id('rr.vid'), NULL, 'email', 1, 'declined', 1512000, 12, seed.id('p.carlos')),
 (seed.id('prop.alufer'),    seed.id('rfp.win'), seed.id('rr.alu'), seed.id('org.alufer'), 'platform', 0, 'invited', NULL, NULL, NULL);
INSERT INTO tendering.proposal_row (id, proposal_id, packaged_task_id, parent_row_id, kind, name, duration_wd, position) VALUES
 (seed.id('pr.atl.1'), seed.id('prop.atlantico'), NULL, NULL, 'task', 'Medição de vãos', 2, 'a'),
 (seed.id('pr.atl.2'), seed.id('prop.atlantico'), NULL, NULL, 'task', 'Fabrico e montagem', 7, 'b');
INSERT INTO tendering.proposal_link VALUES (seed.id('prop.atlantico'), seed.id('pr.atl.1'), seed.id('pr.atl.2'), 'end', 'start', 0);

-- ledger: a few chained entries --------------------------------------------------------------
SELECT record.append_event(seed.id('prj.silva'), '2026-03-02 10:14+00', seed.id('p.ana'), seed.id('org.silva'), 'admin', 'project', 'project.project.created', 'project', seed.id('prj.silva'), 'project', seed.id('prj.silva'), '{"name":"Casa Silva — Lote 12","municipality":"1306"}');
SELECT record.append_event(seed.id('prj.silva'), '2026-04-20 11:02+01', seed.id('p.ana'), seed.id('org.silva'), 'admin', 'contracting', 'contracting.contract.signed', 'contract', seed.id('ctr.prime'), 'contract', seed.id('ctr.prime'), '{"value_cents":8930500,"retention_bp":500}');
SELECT record.append_event(seed.id('prj.silva'), '2026-06-12 15:20+01', seed.id('p.carlos'), seed.id('org.douro'), 'admin', 'contracting', 'contracting.contract.signed', 'contract', seed.id('ctr.sub.plumb'), 'contract', seed.id('ctr.sub.plumb'), '{"value_cents":760000}');
SELECT record.append_event(seed.id('prj.silva'), '2026-09-02 17:58+01', seed.id('p.ines'), seed.id('org.douro'), 'site_lead', 'planning', 'planning.task.updated', 'project', seed.id('prj.silva'), 'task', seed.id('T-200'), '{"field":"finish","old":"2026-08-28","new":"2026-09-11"}');
SELECT record.append_event(seed.id('prj.silva'), '2026-09-15 18:05+01', seed.id('p.carlos'), seed.id('org.douro'), 'admin', 'contracting', 'contracting.change_order.approved', 'contract', seed.id('ctr.sub.win'), 'change_order', seed.id('co.s1'), '{"delta_cents":198000}');
SELECT record.append_event(seed.id('prj.silva'), '2026-09-17 21:40+01', seed.id('p.ana'), seed.id('org.silva'), 'admin', 'contracting', 'contracting.change_order.approved', 'contract', seed.id('ctr.prime'), 'change_order', seed.id('co.p1'), '{"delta_cents":246000,"linked":"CO-S-001"}');
COMMIT;
