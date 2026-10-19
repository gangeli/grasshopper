import json, sys
from PIL import Image
p = sys.argv[1]
m = json.load(open(p + '.json'))
Image.frombytes('RGB', (m['w'], m['h']), open(p + '.rgb', 'rb').read()).save(p)
