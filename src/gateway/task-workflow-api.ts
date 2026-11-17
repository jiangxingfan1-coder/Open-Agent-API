export const WORKFLOW_OPERATIONS = [
  ['/v1/media/formats', 'get', 'Inspect supported artifact format signatures and size limits'],
  [
    '/v1/media/jobs',
    'post',
    'Start an agent media job using the caller execution and credential policy',
  ],
  ['/v1/media/jobs/{id}', 'get', 'Inspect a caller-scoped media job and its actual artifacts'],
  ['/v1/workflows', 'get', 'List private or explicitly project-shared workflow definitions'],
  ['/v1/workflows', 'post', 'Publish a revision-checked reusable agent workflow'],
  [
    '/v1/workflows/{id}/archive',
    'post',
    'Archive a workflow and pause triggers without cancelling accepted executions',
  ],
  [
    '/v1/workflows/{id}/restore',
    'post',
    'Restore an archived workflow with triggers still disabled',
  ],
  [
    '/v1/workflows/validate',
    'post',
    'Validate and lay out a workflow without execution or publication',
  ],
  [
    '/v1/workflows/draft',
    'post',
    'Generate a disabled workflow draft using enforced tool-free reasoning',
  ],
  [
    '/v1/workflows/{id}/run',
    'post',
    'Start a persistent workflow execution with the calling key grants',
  ],
  ['/v1/workflow-runs', 'get', 'List caller-scoped workflow execution checkpoints'],
  ['/v1/workflow-runs/{id}', 'get', 'Inspect one workflow execution and its child run references'],
  ['/v1/workflow-runs/{id}/cancel', 'post', 'Cancel the workflow and its active child calls'],
  [
    '/v1/workflow-runs/{id}/resume',
    'post',
    'Reattach a blocked workflow after its child outcome is resolved',
  ],
] as const;
