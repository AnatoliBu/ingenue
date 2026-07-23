import tempfile
import unittest
from pathlib import Path

from web.ensure_mod_enabled import ensure_enabled, parse_mods, serialize_mods


class ModRegistryTests(unittest.TestCase):
    def test_parse_and_serialize_preserve_order_and_dedupe(self):
        source='''return {
-- Table: {1}
{
   "foo",
   "bar",
   "foo",
},
}'''
        mods=parse_mods(source)
        self.assertEqual(mods,['foo','bar'])
        self.assertEqual(parse_mods(serialize_mods(mods)),mods)

    def test_enable_is_atomic_and_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'data'/'system.mods'
            path.parent.mkdir()
            path.write_text(serialize_mods(['foo','bar']),encoding='utf-8')
            changed,mods=ensure_enabled(str(path),'ingenue')
            self.assertTrue(changed);self.assertEqual(mods,['foo','bar','ingenue'])
            first=path.read_text(encoding='utf-8')
            changed,mods=ensure_enabled(str(path),'ingenue')
            self.assertFalse(changed);self.assertEqual(mods,['foo','bar','ingenue'])
            self.assertEqual(path.read_text(encoding='utf-8'),first)
            self.assertFalse(Path(str(path)+'.ingenue.tmp').exists())


if __name__=='__main__':unittest.main()
