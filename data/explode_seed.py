import json, os, re

BASE = '/tmp/claude-0/-home-claude/44f335b3-a42e-5e19-a0c5-65ee92abf128/scratchpad/seed'
os.makedirs(f'{BASE}/users', exist_ok=True)
os.makedirs(f'{BASE}/roles', exist_ok=True)
os.makedirs(f'{BASE}/departments', exist_ok=True)
os.makedirs(f'{BASE}/delegations', exist_ok=True)
os.makedirs(f'{BASE}/auditLog', exist_ok=True)

roles = json.load(open('roles.json'))
users = json.load(open('users.json'))

# ---- slim roles ----
role_ids = []
for r in roles:
    slim = {
        'name': r['name'],
        'scope': r['scope'],
        'boundOrg': r['boundOrg'] if r['boundOrg'] != '(none)' else None,
        'orgsAssigned': r['orgsAssigned'],
        'adminsInB2G': r['adminsInB2G'],
        'activeAdminsInB2G': r['activeAdminsInB2G'],
        'adminsTotal': r['adminsTotal'],
        'createdAt': r['createdAt'],
        'updatedAt': r['updatedAt'],
        'permissions': r['permissions'],
        'active': True,
    }
    doc_id = r['id']
    role_ids.append(doc_id)
    with open(f'{BASE}/roles/{doc_id}.json', 'w') as f:
        json.dump(slim, f, ensure_ascii=False)

# ---- slim users ----
user_ids = []
dept_counts = {}
for u in users:
    slim = {
        'name': u['name'],
        'email': u['email'],
        'primaryRole': u['primaryRole'] if u['primaryRole'] != '(none)' else None,
        'status': u['status'],
        'department': u['department'],
        'userType': u['userType'],
        'teamLead': u['teamLead'],
        'deptHead': u['deptHead'],
        'homeOrg': u['homeOrg'],
        'orgCount': u['orgCount'],
        'lastActivity': u['lastActivity'],
        'createdAt': u['createdAt'],
        'roles': u['roles'],
        'deleted': False,
        'deletedAt': None,
        'deletedBy': None,
    }
    doc_id = u['id']
    user_ids.append(doc_id)
    dept_counts[u['department']] = dept_counts.get(u['department'], 0) + 1
    with open(f'{BASE}/users/{doc_id}.json', 'w') as f:
        json.dump(slim, f, ensure_ascii=False)

# ---- departments ----
def slugify(s):
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')

dept_ids = []
for name in dept_counts:
    slug = slugify(name)
    dept_ids.append(slug)
    with open(f'{BASE}/departments/{slug}.json', 'w') as f:
        json.dump({'name': name, 'createdAt': '2026-09-21T00:00:00Z', 'archived': False}, f)

# ---- delegation seed: Aya Elnggar -> Education ----
aya = next(u for u in users if u['id'] == '11')
assert aya['name'].startswith('Aya'), aya['name']
with open(f'{BASE}/delegations/del-education-11.json', 'w') as f:
    json.dump({
        'department': 'Education',
        'userId': '11',
        'userName': aya['name'],
        'userEmail': aya['email'],
        'scope': 'department',
        'grantedBy': 'System Setup',
        'grantedAt': '2026-09-21T09:00:00Z',
        'active': True,
        'revokedAt': None,
        'revokedBy': None,
    }, f)

# ---- audit seed ----
audit_entries = [
    ('audit-0001', {
        'ts': '2026-09-21T09:00:00Z',
        'actor': 'System Import',
        'actorRole': 'System',
        'action': 'data_imported',
        'targetUserId': None,
        'targetUserName': None,
        'field': None,
        'oldValue': None,
        'newValue': None,
        'note': f'Initial import from B2G role & permission audit (2026-09-21): {len(user_ids)} users, {len(role_ids)} roles loaded.',
    }),
    ('audit-0002', {
        'ts': '2026-09-21T09:01:00Z',
        'actor': 'Eyad Abdelrhman',
        'actorRole': 'Admin',
        'action': 'delegation_granted',
        'targetUserId': '11',
        'targetUserName': aya['name'],
        'field': 'department_delegation',
        'oldValue': None,
        'newValue': 'Education',
        'note': 'Granted hierarchy management over the Education department.',
    }),
]
for doc_id, data in audit_entries:
    with open(f'{BASE}/auditLog/{doc_id}.json', 'w') as f:
        json.dump(data, f, ensure_ascii=False)

print('roles:', len(role_ids))
print('users:', len(user_ids))
print('departments:', dept_ids)
print('sizes: roles avg', sum(os.path.getsize(f'{BASE}/roles/{i}.json') for i in role_ids)/len(role_ids))
print('sizes: users avg', sum(os.path.getsize(f'{BASE}/users/{i}.json') for i in user_ids)/len(user_ids))

# write manifest for batching
manifest = {
    'roles': [f'{BASE}/roles/{i}.json' for i in role_ids],
    'role_ids': role_ids,
    'users': [f'{BASE}/users/{i}.json' for i in user_ids],
    'user_ids': user_ids,
    'departments': [f'{BASE}/departments/{i}.json' for i in dept_ids],
    'department_ids': dept_ids,
}
with open(f'{BASE}/manifest.json', 'w') as f:
    json.dump(manifest, f)
print('done')
