export const PROJECT_OPERATIONS = [
  ['/v1/projects', 'get', 'List explicitly granted shared projects'],
  ['/v1/projects', 'post', 'Create a shared project without granting other callers access'],
  [
    '/v1/projects/{id}/members',
    'get',
    'Inspect explicit project grants as the owner administrator',
  ],
  [
    '/v1/projects/{id}/members',
    'post',
    'Grant or revoke project memory access for one caller subject',
  ],
  ['/v1/projects/{id}/memory', 'get', 'Read shared project memory with a matching project grant'],
  ['/v1/projects/{id}/memory', 'put', 'Write revision-checked shared project memory'],
  ['/v1/projects/{id}/memory', 'delete', 'Delete one revision-checked shared project memory entry'],
] as const;
