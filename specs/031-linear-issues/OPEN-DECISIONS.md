# Open decisions: Linear issues

These values are not settled yet. They are recorded here so nothing below is mistaken for a settled contract.

1. **Repository links storage.** v1 keeps them per user in the API database. To decide: shared per workspace, or a field on the `Repository` CRD.
2. **Move to In Progress without `linearWrite`.** v1 allows it because the user clicked Start solving. To decide: whether an admin who turned `linearWrite` off expects no status changes at all.
3. **List refresh.** v1 polls every 60 s while the page is visible. To decide: Linear webhooks.
