# Open decisions: Repositories

Unsettled values. They are recorded here so that nothing below is mistaken for a settled contract.

1. **Remote clusters.** v1 is home-cluster only. To open: repositories on registered workload clusters through the remote agent gateway.
2. **Token type.** Fine-grained and classic PATs both work over HTTPS. The Integrations card reads fine-grained token permissions from GitHub; classic tokens report scopes instead. To decide: whether to show both or only "Verified".
3. **Disk default and limits.** Default 2 Gi; whether to cap the size per role.
