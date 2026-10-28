# Vibe for Two

SUN과 BEE의 바이브 코딩 스터디 사이트입니다. 정적 파일(HTML, CSS, JS)로 되어 있고, 데이터와 로그인은 Supabase를 씁니다.

## 폴더 구성

| 파일 | 내용 |
|---|---|
| `index.html` | 화면 뼈대 |
| `style.css` | 디자인 |
| `app.js` | 동작 (로그인, 저장, 권한) |
| `glyph.js` | 메인 화면 빛 글씨 획 데이터 |
| `config.js` | Supabase 연결 정보 (직접 채워야 함) |
| `assets/` | 오실로스코프 배경 사진, 격자 마스크 |
| `supabase/schema.sql` | Supabase에 한 번 실행할 설정 |

`config.js`가 비어 있으면 사이트는 미리보기 모드로 열립니다. 이때 입력 내용은 그 브라우저에만 저장됩니다.

## 설정 순서

### 1. Supabase에 표와 권한 만들기

> 이미 예전 버전 schema.sql을 실행했다면, 새 schema.sql을 한 번 더 실행하면 됩니다. 기존 데이터는 그대로 두고 바뀐 부분만 추가됩니다.

1. Supabase 대시보드에서 기존 프로젝트를 엽니다.
2. 왼쪽 메뉴 **SQL Editor** → **New query**
3. `supabase/schema.sql` 내용을 전부 붙여 넣고 **Run**
4. 맨 아래 6번 주석(관리자 지정)은 아직 실행하지 않습니다. 가입한 뒤에 실행합니다.

기존 앱과 섞이지 않도록 표 이름은 모두 `vft_`로 시작하고, 파일 저장소는 `vft-files`를 따로 씁니다.

### 2. 로그인 설정 확인
- **Authentication → Sign In / Providers → Email**이 켜져 있어야 합니다.
- **Confirm email**이 켜져 있으면 가입할 때 확인 메일이 갑니다. 이 설정은 기존 앱에도 같이 적용되니 지금 상태를 그대로 두세요.
- Supabase 기본 메일 발송은 시간당 보낼 수 있는 수가 적게 제한되어 있습니다. 두 사람이 가입하는 데는 문제없지만, 연달아 여러 번 시도하면 잠시 막힐 수 있습니다.

### 3. config.js 채우기
**Project Settings → API**에서 두 값을 복사합니다.

```js
window.VFT_CONFIG = {
  supabaseUrl: 'https://xxxxxxxx.supabase.co',
  supabaseAnonKey: 'eyJhbGciOi...'
};
```

`anon public` 키만 넣습니다. `service_role` 키는 절대 넣지 마세요.

### 4. GitHub 저장소에 올리기
GitHub에서 새 저장소(예: `vibe-for-two`)를 만든 뒤, 이 폴더에서:

```bash
$ cd vibe-for-two-site
$ git init
$ git add .
$ git commit -m "Vibe for Two 첫 배포"
$ git branch -M main
$ git remote add origin https://github.com/<내아이디>/vibe-for-two.git
$ git push -u origin main
$ git log --oneline -1
```

### 5. Vercel에 배포하기
1. Vercel → **Add New → Project** → 방금 만든 저장소 **Import**
2. Framework Preset: **Other**, Build Command와 Output Directory는 비워 둠
3. **Deploy**

### 6. 배포 주소를 Supabase에 등록
**Authentication → URL Configuration → Redirect URLs**에 Vercel 주소(예: `https://vibe-for-two.vercel.app`)를 추가합니다.
**Site URL은 바꾸지 마세요.** 기존 앱의 메일 링크가 바뀝니다.

### 7. 관리자 지정
1. 배포된 사이트에서 **가입하기**로 닉네임 `BEE` 가입
2. Supabase **SQL Editor**에서 아래 한 줄 실행

```sql
update public.vft_members set role = 'admin' where lower(name) = 'bee';
```

3. 사이트를 새로고침하면 관리자 권한이 적용됩니다.

### 8. 멤버 받기
SUN이 사이트에서 가입하면 **가입 신청**이 생깁니다. 프로젝트 화면의 멤버 칩 옆 **가입 신청** 버튼을 눌러 승인합니다.

## 권한

| 할 수 있는 일 | 방문자 | 멤버 | 매니저 | 관리자 |
|---|:-:|:-:|:-:|:-:|
| 모든 화면 보기 (Works 포함) | O | O | O | O |
| 내 칸 작성·수정 (제목, 주제, 상세, 웹앱 주소, 진행률, 기획, HTML, 파일) | | 본인 칸 | 본인 칸 | 전체 |
| 내 칸 '작업 완료' 표시 (완료한 칸만 Works에 보임) | | 본인 칸 | 본인 칸 | 전체 |
| Works에 개인 작업 올리기 | | O | O | O |
| 개인 작업 수정·삭제 | | 본인 것 | 본인 것 | 전체 |
| 노트 쓰기 | | O | O | O |
| 노트 지우기 | | 본인 글 | 전체 | 전체 |
| 새 프로젝트, 부제 수정 | | | O | O |
| 프로젝트 기간 설정 | | | | O |
| 가입 승인·거절, 멤버 빼기 | | | O (일반 멤버만) | O |
| 매니저 지정·해제 | | | | O |

권한은 화면에서도 막고, Supabase(RLS)에서도 한 번 더 막습니다.
