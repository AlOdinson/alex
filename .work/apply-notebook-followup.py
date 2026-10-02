import base64,gzip,hashlib,json,os,subprocess,sys,urllib.request
from pathlib import Path
BASE='1f0a515d2ce5cbfabf6cf14b346db10977143669'
here=Path(__file__).resolve().parent
target=here.parent/'target'
manifest=json.loads((here/'notebook-drop-manifest.json').read_text())
def git(*args):
    return subprocess.check_output(['git','-C',str(target),*args],text=True).strip()
assert git('rev-parse','HEAD')==BASE
if '--publish-blobs' not in sys.argv:
    patch=gzip.decompress(base64.b64decode((here/'notebook-drop-followup.txt').read_text().strip(),validate=True))
    subprocess.run(['git','-C',str(target),'apply','--check','-'],input=patch,check=True)
    subprocess.run(['git','-C',str(target),'apply','-'],input=patch,check=True)
changed=set(git('diff','--name-only').splitlines())|set(git('ls-files','--others','--exclude-standard').splitlines())
assert changed==set(manifest),changed
for path,expected in manifest.items():
    assert not Path(path).is_absolute() and '..' not in Path(path).parts
    data=(target/path).read_bytes()
    assert hashlib.sha1(f'blob {len(data)}\0'.encode()+data).hexdigest()==expected,path
print('Verified all three exact test-file hashes against published fix baseline')
if '--publish-blobs' in sys.argv:
    result={}
    for path,expected in manifest.items():
        payload=json.dumps({'encoding':'base64','content':base64.b64encode((target/path).read_bytes()).decode()}).encode()
        req=urllib.request.Request('https://api.github.com/repos/AlOdinson/alex/git/blobs',data=payload,headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'Accept':'application/vnd.github+json','Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28'},method='POST')
        with urllib.request.urlopen(req,timeout=60) as response:
            value=json.load(response)
        assert value['sha']==expected,path
        result[path]=value['sha']
    Path('/tmp/notebook-drop-blobs.json').write_text(json.dumps(result,indent=2))
    print('Stored three immutable blobs; no refs or deployments changed')
