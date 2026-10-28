# F21 residual — membership-only write policies (inventory)

`20261024000000_project_data_role_aware_rls.sql` makes the core project data role-aware:
`projects`, `execution_tasks`, `project_milestones`, `raid_items` and
`execution_task_dependencies`. Those are the tables whose role semantics the product defines
(create/update: owner, admin, pm; delete: owner, admin; viewer: read only).

The tables below still have at least one INSERT / UPDATE / DELETE / ALL policy that tests
workspace membership (or `can_access_operational_project`) and nothing role-related. Any member
of the workspace, a viewer included, can therefore perform those writes directly through
PostgREST. Before any of them can be tightened, someone has to decide which roles each table's
writes belong to. Some are plausibly writable by every member (for example a member's own
runtime or UI state); others are not. This PR does not guess.

Generated from the effective policies of a freshly migrated local stack (176 migrations) with
a heuristic: the policy text references membership but contains none of `role`,
`has_workspace_role`, `is_workspace_admin` or `can_write`. Treat it as a review list, not a
proof.

**284 tables** at F21. F22-A (`20261025000000_f22a_tenant_isolation_and_escalation.sql`) has since
made `project_evidence`, `project_evidence_content`, `project_discovery` and `project_decisions`
role-aware. F22-B (`20261026000000_f22b_active_workflow_authorization.sql`) did the same for the
active-workflow tables `vault_documents`, `vault_operational_signals`, `task_drafts`,
`execution_task_events`, `recommended_action_decisions`, `governance_violations`,
`governance_commitments` and `runtime_conversation_state` (own-company copilot state). SEC-W3-1
(`20261029000000_sec_w3_1_governance_brief_writers.sql`) made `operational_governance_briefs`
writer-only, with the project tied to the row's workspace. Those are struck through below. The remaining rows are dormant or still need a per-table role decision.

| Table | Membership-only write commands |
|---|---|
| `agent_action_approval_bridges` | INSERT,UPDATE |
| `agent_action_conversion_events` | INSERT |
| `agent_action_conversion_preflights` | INSERT |
| `agent_action_conversions` | INSERT,UPDATE |
| `agent_audit_events` | INSERT |
| `agent_beta_admin_readiness` | INSERT |
| `agent_beta_invitation_readiness` | INSERT |
| `agent_beta_onboarding_checklist_items` | INSERT |
| `agent_beta_onboarding_checklists` | INSERT,UPDATE |
| `agent_beta_readiness_blockers` | INSERT,UPDATE |
| `agent_beta_readiness_decisions` | INSERT |
| `agent_beta_readiness_events` | INSERT |
| `agent_beta_readiness_exports` | INSERT |
| `agent_beta_readiness_gates` | INSERT,UPDATE |
| `agent_beta_readiness_plans` | INSERT,UPDATE |
| `agent_beta_readiness_remediation_items` | INSERT,UPDATE |
| `agent_beta_user_readiness` | INSERT |
| `agent_beta_workspace_readiness` | INSERT |
| `agent_decision_events` | INSERT |
| `agent_demo_data_bundles` | INSERT,UPDATE |
| `agent_demo_governance_scenarios` | INSERT |
| `agent_demo_handoff_scenarios` | INSERT |
| `agent_demo_project_scenarios` | INSERT |
| `agent_execution_adapter_performance_signals` | INSERT |
| `agent_execution_aggregate_learning_signals` | INSERT |
| `agent_execution_correction_loops` | INSERT,UPDATE |
| `agent_execution_dispatch_attempts` | INSERT,UPDATE |
| `agent_execution_dispatch_events` | INSERT |
| `agent_execution_dispatch_gates` | INSERT,UPDATE |
| `agent_execution_dispatch_idempotency` | INSERT,UPDATE |
| `agent_execution_dispatch_locks` | INSERT,UPDATE |
| `agent_execution_events` | INSERT |
| `agent_execution_evidence_completeness` | INSERT |
| `agent_execution_evidence_items` | INSERT,UPDATE |
| `agent_execution_evidence_quality_signals` | INSERT |
| `agent_execution_failed_dispatch_triage` | INSERT |
| `agent_execution_final_confirmations` | INSERT,UPDATE |
| `agent_execution_finalizations` | INSERT,UPDATE |
| `agent_execution_governance_feedback` | INSERT,UPDATE |
| `agent_execution_human_outcome_reviews` | INSERT,UPDATE |
| `agent_execution_learning_events` | INSERT |
| `agent_execution_learning_extractions` | INSERT,UPDATE |
| `agent_execution_learning_privacy_filters` | INSERT |
| `agent_execution_learning_signals` | INSERT,UPDATE |
| `agent_execution_outcome_comparisons` | INSERT |
| `agent_execution_outcome_confidence` | INSERT |
| `agent_execution_outcome_events` | INSERT |
| `agent_execution_outcome_reconciliations` | INSERT |
| `agent_execution_outcomes` | INSERT,UPDATE |
| `agent_execution_requests` | INSERT |
| `agent_execution_result_events` | INSERT |
| `agent_execution_result_lineage` | INSERT |
| `agent_execution_results` | INSERT,UPDATE |
| `agent_execution_review_decision_patterns` | INSERT |
| `agent_execution_review_routing_feedback` | INSERT |
| `agent_execution_risk_calibration_signals` | INSERT |
| `agent_execution_workspace_learning_summaries` | INSERT |
| `agent_memory_events` | INSERT |
| `agent_memory_records` | INSERT |
| `agent_pmo_active_policy_pointers` | INSERT,UPDATE |
| `agent_pmo_adapter_performance_insights` | INSERT |
| `agent_pmo_approval_checklist_items` | INSERT |
| `agent_pmo_approval_checklists` | INSERT,UPDATE |
| `agent_pmo_approval_pack_artifacts` | INSERT |
| `agent_pmo_approval_pack_events` | INSERT |
| `agent_pmo_approval_pack_exports` | INSERT |
| `agent_pmo_approval_packs` | INSERT,UPDATE |
| `agent_pmo_ci_smoke_checks` | INSERT |
| `agent_pmo_controlled_policy_versions` | INSERT,UPDATE |
| `agent_pmo_controlled_project_assignment_pointers` | INSERT,UPDATE |
| `agent_pmo_database_contract_audits` | INSERT |
| `agent_pmo_dry_run_blockers` | INSERT,UPDATE |
| `agent_pmo_dry_run_change_set_items` | INSERT |
| `agent_pmo_dry_run_change_sets` | INSERT |
| `agent_pmo_dry_run_decisions` | INSERT |
| `agent_pmo_dry_run_events` | INSERT |
| `agent_pmo_dry_run_evidence_packages` | INSERT,UPDATE |
| `agent_pmo_dry_run_evidence_sections` | INSERT |
| `agent_pmo_dry_run_execution_requests` | INSERT,UPDATE |
| `agent_pmo_dry_run_exports` | INSERT |
| `agent_pmo_dry_run_gate_approvals` | INSERT,UPDATE |
| `agent_pmo_dry_run_gate_decisions` | INSERT |
| `agent_pmo_dry_run_operator_reviews` | INSERT,UPDATE |
| `agent_pmo_dry_run_preflight_validations` | INSERT,UPDATE |
| `agent_pmo_dry_run_simulated_impacts` | INSERT |
| `agent_pmo_dry_run_simulation_executions` | INSERT,UPDATE |
| `agent_pmo_error_handling_checks` | INSERT |
| `agent_pmo_evidence_quality_insights` | INSERT |
| `agent_pmo_export_safety_checks` | INSERT |
| `agent_pmo_governance_dashboard_events` | INSERT |
| `agent_pmo_governance_dashboard_snapshots` | INSERT |
| `agent_pmo_governance_feedback_queue` | INSERT,UPDATE |
| `agent_pmo_governance_insight_cards` | INSERT,UPDATE |
| `agent_pmo_governance_report_exports` | INSERT,UPDATE |
| `agent_pmo_handoff_continuity_checks` | INSERT,UPDATE |
| `agent_pmo_idempotency_checks` | INSERT |
| `agent_pmo_implementation_ticket_drafts` | INSERT,UPDATE |
| `agent_pmo_incoming_pm_acceptances` | INSERT |
| `agent_pmo_layer_integration_audits` | INSERT |
| `agent_pmo_observability_coverage_checks` | INSERT |
| `agent_pmo_outgoing_pm_notes` | INSERT,UPDATE |
| `agent_pmo_policy_activation_audit_entries` | INSERT |
| `agent_pmo_policy_activation_events` | INSERT |
| `agent_pmo_policy_activation_executions` | INSERT,UPDATE |
| `agent_pmo_policy_activation_exports` | INSERT |
| `agent_pmo_policy_activation_gate_decisions` | INSERT |
| `agent_pmo_policy_activation_gates` | INSERT,UPDATE |
| `agent_pmo_policy_activation_preconditions` | INSERT,UPDATE |
| `agent_pmo_policy_activation_requests` | INSERT,UPDATE |
| `agent_pmo_policy_draft_diffs` | INSERT |
| `agent_pmo_policy_impact_summaries` | INSERT |
| `agent_pmo_policy_proposals` | INSERT,UPDATE |
| `agent_pmo_policy_rollback_executions` | INSERT,UPDATE |
| `agent_pmo_policy_rollback_gate_decisions` | INSERT |
| `agent_pmo_policy_rollback_gates` | INSERT,UPDATE |
| `agent_pmo_policy_rollback_requests` | INSERT,UPDATE |
| `agent_pmo_policy_rollback_verifications` | INSERT,UPDATE |
| `agent_pmo_post_activation_monitoring_hooks` | INSERT,UPDATE |
| `agent_pmo_production_readiness_decisions` | INSERT |
| `agent_pmo_production_readiness_gates` | INSERT,UPDATE |
| `agent_pmo_project_assignment_history` | INSERT |
| `agent_pmo_project_context_validations` | INSERT,UPDATE |
| `agent_pmo_project_handoff_audit_events` | INSERT |
| `agent_pmo_project_handoff_exports` | INSERT |
| `agent_pmo_project_handoff_gate_decisions` | INSERT |
| `agent_pmo_project_handoff_gates` | INSERT,UPDATE |
| `agent_pmo_project_handoff_packs` | INSERT,UPDATE |
| `agent_pmo_project_handoff_requests` | INSERT,UPDATE |
| `agent_pmo_project_handoff_snapshot_items` | INSERT,UPDATE |
| `agent_pmo_project_memory_snapshots` | INSERT,UPDATE |
| `agent_pmo_project_status_snapshots` | INSERT |
| `agent_pmo_review_routing_insights` | INSERT |
| `agent_pmo_risk_calibration_insights` | INSERT |
| `agent_pmo_rls_policy_audits` | INSERT |
| `agent_pmo_rollback_readiness_checklist_items` | INSERT |
| `agent_pmo_rollback_readiness_checklists` | INSERT,UPDATE |
| `agent_pmo_route_contract_audits` | INSERT |
| `agent_pmo_runtime_hardening_blockers` | INSERT,UPDATE |
| `agent_pmo_runtime_hardening_events` | INSERT |
| `agent_pmo_runtime_hardening_exports` | INSERT |
| `agent_pmo_runtime_hardening_runs` | INSERT,UPDATE |
| `agent_pmo_runtime_remediation_items` | INSERT,UPDATE |
| `agent_pmo_signoff_decisions` | INSERT |
| `agent_pmo_signoff_packets` | INSERT,UPDATE |
| `agent_pmo_simulated_policy_versions` | INSERT,UPDATE |
| `agent_pmo_simulation_report_sections` | INSERT |
| `agent_pmo_simulation_reports` | INSERT,UPDATE |
| `agent_pmo_stakeholder_context_snapshots` | INSERT |
| `agent_pmo_ui_dashboard_integration_checks` | INSERT |
| `agent_pmo_workspace_isolation_checks` | INSERT |
| `agent_review_action_drafts` | INSERT,UPDATE |
| `agent_review_assignments` | INSERT,UPDATE |
| `agent_review_decisions` | INSERT |
| `agent_review_events` | INSERT |
| `agent_review_items` | INSERT,UPDATE |
| `agent_review_queues` | INSERT,UPDATE |
| `agent_tenant_readiness_validations` | INSERT |
| `agent_tool_adapter_execution_events` | INSERT |
| `agent_tool_adapter_executions` | INSERT |
| `agent_tool_requests` | INSERT |
| `authority_delegations` | INSERT |
| `authority_escalations` | INSERT,UPDATE |
| `constitution_amendment_changes` | INSERT |
| `constitution_amendments` | INSERT,UPDATE |
| `constitution_lifecycle_history` | INSERT |
| `constitution_snapshots` | INSERT |
| `constitutional_artifacts` | INSERT,UPDATE |
| `constitutional_decision_evidence` | INSERT |
| `constitutional_decision_links` | INSERT |
| `constitutional_decision_options` | DELETE,INSERT,UPDATE |
| `constitutional_decisions` | INSERT,UPDATE |
| `constitutional_digest_classifications` | INSERT |
| `constitutional_digests` | INSERT |
| `constitutional_learning_evidence` | INSERT |
| `constitutional_learning_patterns` | INSERT,UPDATE |
| `constitutional_learning_recommendations` | INSERT |
| `constitutional_memory_links` | INSERT |
| `constitutional_memory_records` | INSERT,UPDATE |
| `constitutional_ratification_policies` | INSERT,UPDATE |
| `constitutional_recommendation_applications` | INSERT,UPDATE |
| `constitutional_recommendation_effectiveness` | INSERT,UPDATE |
| `constitutional_recommendation_evidence` | INSERT |
| `constitutional_recommendation_feedback` | INSERT |
| `constitutional_recommendation_outcomes` | INSERT |
| `constitutional_recommendations` | INSERT,UPDATE |
| `constitutional_signature_requests` | INSERT,UPDATE |
| `constitutional_signatures` | INSERT,UPDATE |
| `context_conversations` | INSERT |
| `decision_effectiveness` | DELETE,INSERT,UPDATE |
| `decision_effectiveness_observations` | DELETE,INSERT |
| `decision_outcome_links` | INSERT |
| `decision_outcomes` | INSERT |
| `execution_drifts` | ALL |
| `execution_observations` | ALL |
| `execution_projection_dependencies` | ALL |
| `execution_projection_participants` | ALL |
| `execution_projection_tasks` | ALL |
| `execution_projections` | ALL |
| `execution_realities` | ALL |
| ~~`execution_task_events`~~ | ~~INSERT~~ (F22-B) |
| `execution_variances` | ALL |
| `governance_action_assignments` | ALL |
| `governance_action_evidence` | ALL |
| `governance_actions` | ALL |
| `governance_commitment_delegations` | ALL |
| `governance_commitment_evidence` | ALL |
| `governance_commitment_history` | ALL |
| ~~`governance_commitments`~~ | ~~ALL~~ (F22-B) |
| `governance_signal_evidence` | ALL |
| `governance_signal_recommendations` | ALL |
| `governance_signals` | ALL |
| ~~`governance_violations`~~ | ~~INSERT,UPDATE~~ (F22-B) |
| `intervention_memory` | INSERT,UPDATE |
| `message_analyses` | ALL |
| `operational_command_centers` | ALL |
| `operational_consequence_impacts` | ALL |
| `operational_consequence_paths` | ALL |
| `operational_consequence_scenarios` | ALL |
| `operational_consequences` | ALL |
| `operational_decision_evaluations` | ALL |
| `operational_decision_options` | ALL |
| `operational_decision_outcomes` | ALL |
| `operational_decision_tradeoffs` | ALL |
| `operational_decisions` | ALL |
| `operational_focus_items` | ALL |
| `operational_focus_links` | ALL |
| ~~`operational_governance_briefs`~~ | ~~INSERT,UPDATE~~ (SEC-W3-1) |
| `operational_learning_feedback` | ALL |
| `operational_memory_entries` | ALL |
| `operational_outcome_effects` | ALL |
| `operational_outcome_observations` | ALL |
| `organizational_memory` | DELETE,INSERT,UPDATE |
| `organizational_memory_sources` | DELETE,INSERT,UPDATE |
| `organizational_pattern_candidates` | INSERT,UPDATE |
| `organizational_pattern_observations` | DELETE,INSERT |
| `organizational_pattern_sources` | DELETE,INSERT,UPDATE |
| `organizational_patterns` | DELETE,INSERT,UPDATE |
| `pattern_candidate_sources` | INSERT |
| `pattern_extraction_runs` | INSERT,UPDATE |
| `personal_pm_pattern_candidate_sources` | INSERT |
| `personal_pm_pattern_candidates` | INSERT,UPDATE |
| `personal_pm_pattern_extraction_runs` | INSERT,UPDATE |
| `personal_portfolios` | ALL |
| `pilot_agreement_acceptances` | INSERT |
| `platform_events` | INSERT |
| `playbook_audit_events` | INSERT |
| `playbook_recommendations` | INSERT,UPDATE |
| `playbook_snapshots` | INSERT,UPDATE |
| `pmo_alert_payloads` | INSERT,UPDATE |
| `pmo_executive_reports` | INSERT,UPDATE |
| `pmo_intervention_actions` | INSERT,UPDATE |
| `program_cards` | INSERT,UPDATE |
| `program_epics` | INSERT,UPDATE |
| `program_materializations` | ALL |
| `program_roadmap_parse_results` | INSERT,UPDATE |
| `program_roadmap_sources` | INSERT,UPDATE |
| `program_sprints` | INSERT,UPDATE |
| `programs` | INSERT,UPDATE |
| `project_constitution_profiles` | INSERT,UPDATE |
| `project_constitutions` | INSERT,UPDATE |
| `project_decision_evidence_links` | INSERT |
| ~~`project_decisions`~~ | ~~INSERT,UPDATE~~ (F22-A) |
| ~~`project_discovery`~~ | ~~INSERT~~ (F22-A) |
| ~~`project_evidence`~~ | ~~DELETE,INSERT,UPDATE~~ (F22-A) |
| ~~`project_evidence_content`~~ | ~~INSERT,UPDATE~~ (F22-A) |
| `project_memories` | ALL |
| `project_os_attention_items` | ALL |
| `project_os_context_links` | ALL |
| `project_os_snapshots` | ALL |
| `project_suggestions` | ALL |
| ~~`recommended_action_decisions`~~ | ~~INSERT~~ (F22-B) |
| ~~`runtime_conversation_state`~~ | ~~INSERT,UPDATE~~ (F22-B) |
| ~~`task_drafts`~~ | ~~INSERT,UPDATE~~ (F22-B) |
| `vault_digestion_runs` | INSERT |
| ~~`vault_documents`~~ | ~~INSERT,UPDATE~~ (F22-B) |
| `vault_intervention_evidence` | INSERT,UPDATE |
| `vault_intervention_outcomes` | INSERT,UPDATE |
| `vault_interventions` | INSERT,UPDATE |
| `vault_learned_pattern_evidence` | INSERT |
| `vault_learned_patterns` | INSERT,UPDATE |
| `vault_nutrients` | INSERT |
| ~~`vault_operational_signals`~~ | ~~INSERT~~ (F22-B) |
| `vault_semantic_residue` | INSERT |
| `workspace_onboarding_preferences` | INSERT,UPDATE |
