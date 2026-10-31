# Deploy server group image

Sets `spec.template.image` of a StatefulSet server group (`GameServerSet` with `mode: StatefulSet`). The operator writes the image into the group's StatefulSet, which replaces the replicas one at a time, highest ordinal first, waiting for each to be Ready for `spec.minReadySeconds`.

## Cluster side

Add a deployer to the chart values. It may only `get`/`patch` the listed groups and read their StatefulSets:

```yaml
deployers:
  - name: smp-deployer
    serverSets: [smp-overworld, smp-spawn]
```

Build a kubeconfig from the token Secret the chart creates (`<name>-token` in the games namespace):

```sh
NS=gameplane-games
TOKEN=$(kubectl -n $NS get secret smp-deployer-token -o jsonpath='{.data.token}' | base64 -d)
kubectl -n $NS get secret smp-deployer-token -o jsonpath='{.data.ca\.crt}' | base64 -d > ca.crt
kubectl config --kubeconfig deployer.yaml set-cluster gameplane --server https://<apiserver>:6443 --certificate-authority ca.crt --embed-certs
kubectl config --kubeconfig deployer.yaml set-credentials smp-deployer --token "$TOKEN"
kubectl config --kubeconfig deployer.yaml set-context default --cluster gameplane --user smp-deployer --namespace $NS
kubectl config --kubeconfig deployer.yaml use-context default
```

Store `deployer.yaml` as a repository secret, e.g. `GAMEPLANE_KUBECONFIG`.

## Workflow side

```yaml
- uses: chunksmith/Gameplane/.github/actions/deploy-server-group@master
  with:
    kubeconfig: ${{ secrets.GAMEPLANE_KUBECONFIG }}
    name: smp-overworld
    image: ghcr.io/chicken-network-mc/server-smp-overworld:prod-${{ github.sha }}
```

`timeout: 0` returns right after the patch; the default waits up to 90 minutes for the rollout.
