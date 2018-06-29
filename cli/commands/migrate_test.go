package commands

import (
	"database/sql"
	sqldriver "database/sql/driver"
	"fmt"
	"io"
	"io/ioutil"
	"os"
	"path"
	"path/filepath"
	"testing"

	mt "github.com/hasura/graphql-engine/cli/migrate/testing"
	_ "github.com/lib/pq"
	"github.com/parnurzeal/gorequest"
	"github.com/stretchr/testify/assert"
)

var postgresVersions = []mt.Version{
	{Image: "postgres:9.6"},
}

var ravenVersions = []mt.Version{
	{Image: "hasura/graphql-engine:190d78e", Cmd: []string{"raven", "serve", "--database-url"}, ExposedPort: 8080},
}

var testMetadata = map[string][]byte{
	"metadata": []byte(`query_templates: []
tables:
- array_relationships: []
  delete_permissions: []
  insert_permissions: []
  object_relationships: []
  select_permissions: []
  table: test
  update_permissions: []
`),
	"empty-metadata": []byte(`query_templates: []
tables: []
`),
}

func isReadyPostgres(i mt.Instance) bool {
	db, err := sql.Open("postgres", fmt.Sprintf("postgres://postgres@%v:%v/postgres?sslmode=disable", i.Host(), i.Port()))
	if err != nil {
		return false
	}

	defer db.Close()
	if err = db.Ping(); err != nil {
		switch err {
		case sqldriver.ErrBadConn, io.EOF:
			return false
		default:
			fmt.Println(err)
		}
		return false
	}
	return true
}

func isReadyRaven(i mt.Instance) bool {
	request := gorequest.New()
	_, _, errs := request.Post(fmt.Sprintf("http://%s:%d", i.Host(), i.Port())).End()
	if len(errs) == 0 {
		return true
	}
	return false
}

func TestMigrateCmd(t *testing.T) {
	mt.ParallelTest(t, postgresVersions, isReadyPostgres,
		func(t *testing.T, pi mt.Instance) {
			for i, v := range ravenVersions {
				ravenVersions[i].Cmd = append(v.Cmd, fmt.Sprintf("postgres://postgres@%v:%v/postgres?sslmode=disable", pi.NetworkSettings().Gateway, pi.Port()))
			}
			mt.ParallelTest(t, ravenVersions, isReadyRaven,
				func(t *testing.T, ri mt.Instance) {
					defer pi.Remove()
					defer ri.Remove()

					endpoint := fmt.Sprintf("http://%s:%d", ri.Host(), ri.Port())
					// Create migration Dir
					migrationsDir, err := ioutil.TempDir("", "")
					if err != nil {
						t.Fatal(err)
					}
					defer os.RemoveAll(migrationsDir)

					executionDir, err := ioutil.TempDir("", "")
					if err != nil {
						t.Fatal(err)
					}
					defer os.RemoveAll(executionDir)

					// Create 1_create_table_test.up.sql which creates table test
					mustWriteFile(t, migrationsDir, "1_create_table_test.up.sql", `CREATE TABLE "test"("id" serial NOT NULL, PRIMARY KEY ("id") )`)
					// Create 1_create_table_test.down.sql which creates table test
					mustWriteFile(t, migrationsDir, "1_create_table_test.down.sql", `DROP TABLE "test";`)
					// Create 2_add_table_test.up.yaml which adds table test to metadata
					mustWriteFile(t, migrationsDir, "2_add_table_test.up.yaml", `- args:
    name: test
  type: add_existing_table_or_view
`)
					mustWriteFile(t, migrationsDir, "2_add_table_test.down.yaml", `- args:
    table: test
  type: untrack_table
`)

					// Apply 1_create_table_test.up.sql
					testMigrateApply(t, endpoint, migrationsDir, "1", "", "", "")

					// Check Migration status
					testMigrateStatus(t, endpoint, migrationsDir, "VERSION  SOURCE STATUS  DATABASE STATUS\n1        Present        Present\n2        Present        Not Present\n")

					// Apply 2_add_table_test.up.yaml
					testMigrateApply(t, endpoint, migrationsDir, "", "", "2", "")

					// Check Migration status
					testMigrateStatus(t, endpoint, migrationsDir, "VERSION  SOURCE STATUS  DATABASE STATUS\n1        Present        Present\n2        Present        Present\n")

					// Apply 2_add_table_test.down.yaml
					testMigrateApply(t, endpoint, migrationsDir, "", "1", "", "")

					// Check Migration status
					testMigrateStatus(t, endpoint, migrationsDir, "VERSION  SOURCE STATUS  DATABASE STATUS\n1        Present        Present\n2        Present        Not Present\n")

					// Apply 1_create_table_test.down.sql
					testMigrateApply(t, endpoint, migrationsDir, "", "", "1", "down")

					// Check Migration status
					testMigrateStatus(t, endpoint, migrationsDir, "VERSION  SOURCE STATUS  DATABASE STATUS\n1        Present        Not Present\n2        Present        Not Present\n")

					// Apply both 1 and 2
					testMigrateApply(t, endpoint, migrationsDir, "", "", "", "")

					testMetadataExport(t, executionDir, endpoint)
					compareMetadata(t, executionDir, testMetadata["metadata"])

					testMetadataApply(t, executionDir, endpoint)
					testMetadataExport(t, executionDir, endpoint)
					compareMetadata(t, executionDir, testMetadata["metadata"])

					testMetadataReset(t, executionDir, endpoint)
					testMetadataExport(t, executionDir, endpoint)
					compareMetadata(t, executionDir, testMetadata["empty-metadata"])
				})
		})
}

func mustWriteFile(t testing.TB, dir, file string, body string) {
	if err := ioutil.WriteFile(path.Join(dir, file), []byte(body), 06444); err != nil {
		t.Fatal(err)
	}
}

func compareMetadata(t testing.TB, executionDir string, actualData []byte) {
	data, err := ioutil.ReadFile(filepath.Join(executionDir, "metadata.yaml"))
	if err != nil {
		t.Fatalf("error reading metadata %s", err)
	}
	assert.Equal(t, actualData, data)
}
